/**
 * The one `LlmAdapter` every driver is served through.
 *
 * This class exists so that no driver has to know what DSH is. It owns the
 * entire harness-facing surface — provider info, model listing, capability
 * resolution, call preparation — and every one of those methods ends in the same
 * place: a question answered by the driver's catalog, or a stream produced by
 * the driver's session. The driver supplies *facts and bytes*; this class
 * supplies *DSH*.
 *
 * That split is the whole architecture in one file. Adding a vendor means
 * writing a driver and touching nothing here.
 *
 * ## What it deliberately does not do
 *
 * - **No protocol translation.** A driver emits the harness's own chunk union.
 *   There is no intermediate "unified" representation, because such a layer
 *   would have to model every vendor's quirks and would break for all of them at
 *   once when it got one wrong.
 * - **No retry, no timeout.** The harness never retries (`dsh-llm-retry` does),
 *   so a second retry layer here would multiply attempts invisibly.
 * - **No cross-vendor fallback.** A driver that fails fails alone.
 *
 * @module dsh-agent-bridge/adapter
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { toLlmError } from './llm-error.js';
import { buildReasoning, wireEffort } from './effort.js';
import { formatQuota, withSuffix } from './quota.js';
import { normalizeMessages } from './messages.js';
import { Pool, OVERFLOW_PREFIX } from './pool.js';

/**
 * Text prepended to a conversation as a leading system message.
 *
 * The harness is a coding agent: its prompt describes tools, file access, and
 * shell commands, none of which exist behind these proxies. Without this the
 * model tends to answer with tool syntax the harness will not act on, or refuses
 * for want of a file it cannot read. Stating the actual situation once, up front,
 * is cheaper and more reliable than stripping the harness's own prompt.
 *
 * A driver whose upstream runs its own agent harness sets `ownSystemPrompt` and
 * does not get this. See {@link DriverAdapter.stream} for the measurement that
 * made that a contract rather than a per-driver hack.
 */
export const PROXY_PREAMBLE = [
  'You are being reached through an API proxy that carries only the conversation text.',
  'You have no tools, no file access, no shell, and no ability to run commands in this session.',
  'Answer directly in prose. Never emit tool-call syntax or claim to have inspected anything.',
  'If a request genuinely cannot be answered without a utility you do not have, say so plainly.'
].join(' ');

/**
 * Advertised for every model of every vendor.
 *
 * None of the surfaces this plugin drives accepts image content, and claiming
 * otherwise would admit an attachment the upstream rejects *after* the message is
 * durable — the failure would read as the model refusing rather than as the
 * adapter over-promising.
 */
export const INPUT_MODALITIES = Object.freeze(['text']);

/** Fallback context window when a vendor states none. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Fallback output ceiling when a vendor states none. */
export const DEFAULT_MAX_TOKENS = 32_000;

/** Most pooled sessions held at once. */
export const MAX_SESSIONS = 4;

export class DriverAdapter extends LlmAdapter {
  #provider;
  #driver;
  #displayName;
  #pool;
  #closed = false;
  #logger;

  /**
   * @param {object} options
   * @param {string} options.provider - the route id registered with DSH.
   * @param {string} options.displayName - the human name of the group.
   * @param {object} options.driver - the driver implementation.
   * @param {object} options.catalog - the driver's catalog store.
   * @param {{debug?: Function, info?: Function, warn?: Function}} [options.logger]
   */
  constructor(options) {
    super();
    this.#provider = options.provider;
    this.#displayName = options.displayName;
    this.#driver = options.driver;
    this.catalog = options.catalog;
    this.#logger = options.logger;
    this.#pool = new Pool({
      budget: MAX_SESSIONS,
      close: (session) => session?.close?.(),
      onError: (error) => this.#logger?.debug?.(`bridge/${this.#provider}: session close failed: ${String(error)}`)
    });
  }

  /** The driver's catalog. Empty means DSH hides this provider group. */
  catalog;

  /** The route id this adapter was registered under. */
  get provider() {
    return this.#provider;
  }

  /** The catalog, or a clear failure when the host mis-wired the plugin. */
  #requireCatalog() {
    if (this.catalog === undefined) throw new Error(`${this.#provider}: adapter has no catalog attached`);
    return this.catalog;
  }

  /** The normalized row for one model id. */
  #rowFor(model) {
    return this.#requireCatalog().current().find((entry) => entry.id === model);
  }

  /**
   * Describe this provider route.
   *
   * The account balance rides the group name, not the model names: the picker
   * renders this string once as the group header and renders every model's `name`
   * inside it, so folding the balance in here shows it exactly once instead of
   * repeating one figure across nineteen rows. `LlmProviderInfo` has no other
   * field for it, and `model.description` is not read by the picker at all.
   *
   * DSH reads this at registration, so the host re-registers when the balance
   * changes; see `replaceRoutes` on the adapter.
   *
   * @returns {import('@deepseek-ai/dsh-llm').LlmProviderInfo}
   */
  providerInfo(provider) {
    return { id: provider, name: withSuffix(this.#displayName, this.#suffix()) };
  }

  /**
   * The balance text for this account, or `undefined`.
   *
   * A vendor without a balance interface, or an account whose last balance call
   * failed, contributes nothing — an invented figure would be worse than none.
   */
  #suffix() {
    const catalog = this.#requireCatalog();
    const quota = catalog.quota();
    if (quota === undefined) return undefined;
    // A driver may spell its own balance text (a unit word, a prefix); the
    // shared formatter is the fallback, not the authority.
    return this.#driver.formatQuota?.(quota) ?? formatQuota(quota);
  }

  /** The display name for one row. */
  #display(row) {
    return row.name ?? row.id;
  }

  /**
   * Whether a model is reasoning-capable and, if so, which levels it offers.
   *
   * Delegated to the driver twice over: the row may declare its own set, and the
   * driver may know something the row does not (a worker listing, a static
   * table). Either way an empty result means **no control**, and the adapter then
   * never sends the field at all.
   */
  #reasoningFor(row) {
    return buildReasoning(row, this.#driver.efforts?.(row));
  }

  /** The context window for one row, preferring whatever the driver computes. */
  #contextWindow(row) {
    const declared = this.#driver.context?.(row);
    if (typeof declared?.window === 'number' && declared.window > 0) return declared.window;
    return positive(row.contextWindow, DEFAULT_CONTEXT_WINDOW);
  }

  /**
   * The models to show in the picker.
   *
   * Nothing is invented here: DSH requires a model to be in this list for the
   * selection UI to submit at all, so an entry with guessed metadata would create
   * a choice that cannot be used.
   */
  async listModels(provider) {
    return this.#requireCatalog()
      .current()
      .map((row) => ({
        provider,
        id: row.id,
        name: this.#display(row),
        ...(text(row.description) === undefined ? {} : { description: text(row.description) }),
        inputModalities: INPUT_MODALITIES
      }));
  }

  /**
   * Resolve one model's full capability record.
   *
   * The bounded `whenReady` wait matters: the harness validates a requested
   * effort against what this returns, so an unloaded catalog would reject a
   * configured default model with `UNSUPPORTED_REASONING_EFFORT` for the whole
   * startup window.
   */
  async resolveModel(provider, model) {
    await this.#requireCatalog().whenReady();
    const row = this.#rowFor(model);
    if (row === undefined) throw new Error(`${this.#provider}: model "${model}" is not in the catalog`);
    const contextWindow = this.#contextWindow(row);
    const reasoning = this.#reasoningFor(row);
    return {
      provider,
      id: row.id,
      name: this.#display(row),
      ...(text(row.description) === undefined ? {} : { description: text(row.description) }),
      inputModalities: INPUT_MODALITIES,
      context: { contextWindow },
      // A ceiling above the window would be rejected by the harness's own
      // validator, and the smaller of the two is what the vendor will honour.
      defaultMaxTokens: Math.min(positive(row.maxTokens, DEFAULT_MAX_TOKENS), contextWindow),
      ...(reasoning === undefined ? {} : { reasoning })
    };
  }

  /**
   * Bind one resolved model to the stream this adapter will produce.
   *
   * Called at startup by the harness as well as per turn, which is why it must
   * stay safe before the first catalog refresh — `resolveModel` handles that with
   * its bounded wait, and an unreachable account therefore produces a startup
   * failure rather than a hung boot.
   */
  async prepareCall(provider, model, _signal) {
    const info = await this.resolveModel(provider, model);
    return { model: info, stream: (options) => this.stream({ ...options, provider, model }) };
  }

  /** The pool key for one call: one open conversation per DSH session. */
  #keyFor(options) {
    return typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : '__default__';
  }

  /**
   * Produce the response stream for one turn.
   *
   * Message history policy is the driver's, not this method's: a driver whose
   * upstream keeps a conversation sends only the new turn, while one that faces a
   * stateless endpoint replays everything. Both are correct, and only the driver
   * knows which it faces — so the full list is always handed over.
   *
   * ## The preamble is conditional, and it has to be
   *
   * A driver whose upstream supplies its own agent system prompt declares
   * `ownSystemPrompt` and does not receive {@link PROXY_PREAMBLE}. This is not
   * tidiness — it was measured on a driver since retired from this plugin, whose
   * upstream owned a full agent prompt with its own tool list: the preamble landed
   * *inside* the user turn (the transcript is flattened into one string), where it
   * contradicted the upstream's real system prompt. The model read the
   * contradiction as an injection attempt and spent 878 output tokens deliberating
   * over a one-word answer before replying. With the preamble withheld the same
   * turn is direct.
   *
   * So the rule is: prepend the preamble when the upstream has no framing of its
   * own, withhold it when the upstream has framing that ours would contradict —
   * and withhold it whenever the caller supplies real tools, because "you have no
   * tools" is then simply false, and a model handed both a tool list and a denial
   * answers with `<tool_call>` written as prose. That was the failure this vendor
   * shipped with: every tool-using turn arrived as an empty message.
   */
  async *stream(options) {
    if (this.#closed) throw new Error(`${this.#provider}: adapter is closed`);
    const tools = toolDeclarations(options.tools);
    const lead =
      this.#driver.ownSystemPrompt === true || tools !== undefined
        ? []
        : [{ role: 'system', content: PROXY_PREAMBLE }];
    const messages = normalizeMessages([
      ...lead,
      ...(typeof options.system === 'string' && options.system.length > 0 ? [{ role: 'system', content: options.system }] : []),
      ...(Array.isArray(options.messages) ? options.messages : [])
    ]);
    const effort = wireEffort(options.reasoningEffort);
    const key = this.#keyFor(options);
    const { session, overflowKey } = await this.#claim(key);

    let completed = false;
    try {
      for await (const chunk of session.send(messages, {
        model: options.model,
        effort,
        signal: options.signal,
        ...(tools === undefined ? {} : { tools })
      })) {
        yield chunk;
      }
      completed = true;
    } catch (error) {
      // Everything the driver knows about the failure is in this error, and the harness will
      // throw all of it away unless it is an `LlmError` — see `lib/failure.js` for what is lost
      // and for the local reproduction. The conversion happens here because this is the last
      // point that speaks both vocabularies.
      throw toLlmError(error, this.#provider);
    } finally {
      const closingKey = overflowKey ?? key;
      if (completed && overflowKey === undefined) {
        this.#pool.release(closingKey, true);
      } else {
        // A failed or aborted turn leaves the upstream mid-conversation, and an
        // overflow session was never meant to outlive its turn.
        this.#pool.discard(closingKey);
      }
    }
  }

  /**
   * Take the pooled session for a key, or open one beside it.
   *
   * A busy key is the normal contention case — the desktop app and DSH sharing
   * one agent worker — so it produces a throwaway session rather than a failed
   * turn. That session is closed when the turn ends.
   */
  async #claim(key) {
    const taken = this.#pool.take(key);
    if (taken.state === 'taken') return { session: taken.handle };
    if (taken.state === 'busy' || this.#pool.saturated) {
      const overflowKey = `${key}${OVERFLOW_PREFIX}${Pool.discriminator()}`;
      const session = await this.#driver.openSession({ key: overflowKey, logger: this.#logger });
      this.#pool.put(overflowKey, session);
      return { session, overflowKey };
    }
    const session = await this.#driver.openSession({ key, logger: this.#logger });
    this.#pool.put(key, session);
    return { session };
  }

  /** Whether the driver reports an install and a sign-in right now. */
  async locate() {
    return this.#driver.locate();
  }

  /**
   * Close every pooled session, then let the driver release what it holds outside
   * the pool.
   *
   * The second step is not optional. A driver keeps resources that are not any
   * one conversation: the catalogue child process a listing was served from, a
   * cached at-rest key, a module-level memo. Only the driver knows about them, so
   * the adapter must ask — and a test that leaves a child process alive is the
   * visible symptom of forgetting to.
   */
  async close() {
    this.#closed = true;
    await this.#pool.close();
    try {
      await this.#driver.close?.();
    } catch (error) {
      this.#logger?.debug?.(`bridge/${this.#provider}: driver close failed: ${String(error)}`);
    }
  }
}

/** Trimmed non-empty text, or `undefined`. */
function text(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The harness's tool definitions, reduced to what a driver needs.
 *
 * `GenerateOptions.tools` carries `{ name, description, parameters }` where
 * `parameters` is a JSON Schema. Drivers re-spell this for their own wire, so the
 * shape is passed through unchanged rather than translated twice. An entry with
 * no usable name is dropped: forwarding it makes the upstream reject the whole
 * request, and that failure would surface as an empty answer rather than as a
 * bad schema.
 *
 * @param {unknown} tools
 * @returns {{name: string, description?: string, parameters?: unknown}[] | undefined}
 */
function toolDeclarations(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const declarations = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue;
    declarations.push({
      name: tool.name,
      ...(typeof tool.description === 'string' && tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters })
    });
  }
  return declarations.length === 0 ? undefined : declarations;
}

/** A positive finite number, or the fallback. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
