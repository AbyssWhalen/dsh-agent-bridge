/**
 * The WorkBuddy upstream HTTP client.
 *
 * WorkBuddy is the one vendor here that is reached over plain HTTP rather than
 * through a local process, so this module is the whole transport. The endpoints,
 * headers, and body quirks are all load-bearing and all measured; each one is
 * documented where it is applied, because a reader who changes one needs to know
 * what it was defending against.
 *
 * ## The quirks that matter
 *
 * - **`developer` must become `system`.** The OpenAI convention the harness
 *   follows spells the leading prompt `developer`, and the upstream rejects that
 *   role outright. This is the single most surprising requirement in the file.
 * - **`stream: true` is mandatory.** A non-streaming request is refused, so there
 *   is no non-streaming path to fall back to.
 * - **`reasoning_effort: "off"` must be dropped, not translated.** Both regional
 *   endpoints reject the literal; omission is the only spelling measured good on
 *   every model that validates the field. A literal `none` is *not* a substitute.
 * - **The catalog is selected by User-Agent, not by path.** The gateway splits
 *   `/v3/config` by client identity, and only the CLI-shaped UA yields the roster
 *   these requests can actually use.
 * - **HTTP 400 code 11128 is ambiguous.** It means "first message is not system"
 *   on the international endpoint and "rejected `developer` role" on the CN one,
 *   so nothing here branches on the code alone.
 *
 * @module dsh-agent-bridge/drivers/workbuddy/upstream
 */
import { VARIANT } from './auth.js';

/** Chat endpoint origin for the CN region. */
export const CN_CHAT_BASE = 'https://copilot.tencent.com';

/** Billing endpoint origin for the CN region. */
export const CN_BILLING_BASE = 'https://www.codebuddy.cn';

/** Origin for the international region, used for chat, billing, and catalog. */
export const GLOBAL_BASE = 'https://www.workbuddy.ai';

/** The CLI-shaped User-Agent; see the catalog UA note in the module docstring. */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** How long a JSON request may take. */
export const JSON_TIMEOUT_MS = 30_000;

/** Most of an error body kept for the failure message. */
export const ERROR_BODY_LIMIT = 4096;

/** App version used when nothing more specific resolves. */
export const FALLBACK_APP_VERSION = '5.5.2';

/** CN app version used when nothing more specific resolves. */
export const FALLBACK_CN_APP_VERSION = '5.5.6';

/** The concrete effort spellings the upstream accepts on the wire. */
export const EFFORT_VALUES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/** Badge tag prefix in the upstream's `tags` array. */
const BADGE_PREFIX = 'badge:';

/** System prompt prepended when the international endpoint sees no system turn. */
const INTERNATIONAL_SYSTEM_PROMPT = 'You are a helpful assistant.';

/** Body markers that mean the account's credit is gone rather than the request bad. */
const HARD_CREDIT_MARKERS = ['积分', '额度', '余额不足', 'credits', 'insufficient', 'quota', '402'];

/** Markers that mean the stored session is dead and the app must sign in again. */
const SESSION_DEAD_MARKERS = ['Offline user session not found', '12153'];

/**
 * Whether a value is an object worth reading fields from.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A positive finite number.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** The region a login domain belongs to; an empty domain means CN. */
export function regionOf(domain) {
  const lowered = String(domain ?? '').trim().toLowerCase();
  if (lowered === 'workbuddy.ai' || lowered.endsWith('.workbuddy.ai')) return 'global';
  return 'cn';
}

/** The chat origin for one credential. */
export function chatBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE;
}

/** The billing origin for one credential. */
export function billingBase(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE;
}

/** The origin used for `Origin` / `Referer` on one credential. */
function originReferer(credential) {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE;
}

/** Headers every upstream request shares. */
function commonHeaders(credential) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA
  };
}

/**
 * Chat request headers, including the `X-No-*` conventions the official CLI uses.
 *
 * The `X-No-*` spellings are not redundant: an absent identity field is announced
 * explicitly rather than sent empty, and an empty `X-Domain` has been observed to
 * be treated as a real (and wrong) domain.
 */
export function chatHeaders(credential, userAgent, clientVersion) {
  return {
    ...commonHeaders(credential),
    'User-Agent': userAgent,
    'Content-Type': 'application/json',
    ...(credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': clientVersion,
    'X-Product': 'SaaS'
  };
}

/** Billing request headers. */
function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid;
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
    headers['X-Tenant-Id'] = credential.enterpriseId;
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain;
  return headers;
}

/** Refresh-endpoint headers; `X-Refresh-Token` appears here and nowhere else. */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy'
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
  }
  return headers;
}

/**
 * The chat User-Agent for the CN region.
 *
 * The gateway has never been observed to branch on the version number, so the
 * compiled-in value is a shape requirement rather than a currency claim — which
 * is exactly why no attempt is made to read the installed app's version here.
 */
export function chatUserAgent(region) {
  const version = region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION;
  const product = region === 'global' ? 'WorkBuddy AI' : 'WorkBuddy';
  return `WorkBuddy/${version} ${product}/${version}`;
}

/** The App-shaped User-Agent for catalog requests on the international region. */
export function appUserAgent(version) {
  return `WorkBuddyAI/${version}`;
}

/**
 * Rewrite `role: "developer"` to `role: "system"`.
 *
 * Load-bearing. The harness's leading prompt reaches the wire as `developer`,
 * and the upstream answers HTTP 400 for that role.
 *
 * @param {object} body
 */
function normalizeDeveloperRole(body) {
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages) {
    if (!isObject(message)) continue;
    if (message.role === 'developer') message.role = 'system';
  }
}

/**
 * Flatten OpenAI `tool_choice` spellings into the upstream's string form.
 *
 * This plugin sends no tools, so the whole branch is defensive: a caller that
 * attached tools would otherwise get an opaque 400 rather than a request the
 * upstream understands.
 *
 * @param {object} body
 */
function normalizeToolChoice(body) {
  const suppress = () => {
    delete body.tools;
    delete body.functions;
  };
  if (!('tool_choice' in body)) return;
  const choice = body.tool_choice;
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete body.tool_choice;
      suppress();
    }
    return;
  }
  if (isObject(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
    if (type === 'none') {
      delete body.tool_choice;
      suppress();
      return;
    }
    if (type === 'auto' || type === 'required') {
      body.tool_choice = type;
      return;
    }
    if (type === 'function') {
      const name = typeof choice.function?.name === 'string' ? choice.function.name.trim() : '';
      body.tool_choice = name !== '' ? name : 'auto';
      return;
    }
  }
  delete body.tool_choice;
}

/**
 * Drop the `off` effort spelling from the wire.
 *
 * Both endpoints reject the literal `off`, so it is omitted rather than
 * translated. The consequence is stated plainly rather than hidden: selecting
 * "Off" means the field is absent, and whether that actually disables thinking is
 * the upstream's decision, not this plugin's.
 *
 * @param {object} body
 */
function dropUnsupportedEffort(body) {
  if (body.reasoning_effort === 'off') delete body.reasoning_effort;
}

/**
 * Normalize a chat body for the upstream.
 *
 * @param {object} source - the request body as a plain object.
 * @param {'cn' | 'global'} region
 * @returns {object} a new object; the input is not mutated.
 */
export function prepareChatBody(source, region) {
  const body = JSON.parse(JSON.stringify(source));
  body.stream = true;
  normalizeDeveloperRole(body);
  normalizeToolChoice(body);
  dropUnsupportedEffort(body);
  if (region === 'global') {
    const messages = body.messages;
    if (Array.isArray(messages) && !(isObject(messages[0]) && messages[0].role === 'system')) {
      messages.unshift({ role: 'system', content: INTERNATIONAL_SYSTEM_PROMPT });
    }
  }
  return body;
}

/**
 * Read an upstream JSON envelope.
 *
 * WorkBuddy answers with `{code, msg, data}` where `code === 0` means success, so
 * an HTTP 200 carrying a non-zero code is still a failure and is classified the
 * same way an HTTP error would be.
 *
 * @param {Response} response
 * @returns {Promise<{code: number, msg: string, data: unknown, document: object}>}
 */
export async function readEnvelope(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
  }
  if (!isObject(parsed)) {
    throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
  }
  return {
    code: typeof parsed.code === 'number' ? parsed.code : 0,
    msg: typeof parsed.msg === 'string' ? parsed.msg : '',
    data: 'data' in parsed ? parsed.data : undefined,
    document: parsed
  };
}

/** Fail an envelope whose business code is non-zero. */
export function envelopeError(status, envelope) {
  const kind = classifyUpstreamError(status, envelope.msg);
  return new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}

/**
 * Classify an upstream failure from its HTTP status and body excerpt.
 *
 * @param {number} status
 * @param {string} body
 * @returns {'hard_credit' | 'session_dead' | 'soft_rate' | 'not_found' | 'server' | 'client'}
 */
export function classifyUpstreamError(status, body) {
  if (status === 402) return 'hard_credit';
  if (status === 401) return 'session_dead';
  const lower = String(body ?? '').toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase())) return 'hard_credit';
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (String(body ?? '').includes(marker)) return 'session_dead';
  }
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'client';
}

/**
 * Pull the user-facing message out of an upstream error body.
 *
 * Prefers the localized `displayMsg` the upstream sends, because those strings
 * are what the desktop app itself shows and are already in the user's language.
 *
 * @param {string} body
 * @returns {string | undefined}
 */
export function extractDisplayErrorMessage(body) {
  const trimmed = String(body ?? '').trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  if (isObject(parsed.displayMsg)) {
    const zh = typeof parsed.displayMsg.zh === 'string' ? parsed.displayMsg.zh.trim() : '';
    if (zh !== '') return zh;
    const en = typeof parsed.displayMsg.en === 'string' ? parsed.displayMsg.en.trim() : '';
    if (en !== '') return en;
  }
  const msg = typeof parsed.msg === 'string' ? parsed.msg.trim() : '';
  return msg === '' ? undefined : msg;
}

/**
 * Reduce an upstream credits string to its language-neutral form.
 *
 * Some rows report a bare multiplier (`x0.79`) and others append a unit word;
 * dropping the trailing `credits` yields the one spelling that reads the same in
 * every UI language.
 *
 * @param {unknown} credits
 * @returns {string | undefined}
 */
export function normalizeCredits(credits) {
  if (typeof credits !== 'string') return undefined;
  const trimmed = credits.trim();
  if (trimmed === '') return undefined;
  if (/^credits?$/iu.test(trimmed)) return undefined;
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim();
  return bare === '' ? undefined : bare;
}

/**
 * Parse one upstream catalog row's reasoning declaration.
 *
 * `canDisableThinking` defaults to **true** when the field is absent, matching the
 * upstream's own default: a model that does not mention it can still be switched
 * off. A declared `supportedEfforts` set always beats any later observation, which
 * is why nothing here probes.
 *
 * @param {object} row
 * @returns {{supports: boolean, onlyReasoning: boolean, supportedEfforts?: string[], defaultEffort?: string, canDisableThinking: boolean}}
 */
export function resolveUpstreamReasoning(row) {
  const supports = row.supportsReasoning === true;
  const onlyReasoning = row.onlyReasoning === true;
  let supportedEfforts;
  let defaultEffort;
  let canDisableThinking = true;
  if (isObject(row.reasoning)) {
    const raw = row.reasoning.supportedEfforts;
    if (Array.isArray(raw)) {
      const efforts = raw.filter((value) => typeof value === 'string' && EFFORT_VALUES.includes(value));
      if (efforts.length > 0) supportedEfforts = efforts;
    }
    const declared = typeof row.reasoning.defaultEffort === 'string' ? row.reasoning.defaultEffort : row.reasoning.effort;
    if (typeof declared === 'string' && EFFORT_VALUES.includes(declared)) defaultEffort = declared;
    canDisableThinking = row.reasoning.canDisableThinking === true;
  }
  return {
    supports,
    onlyReasoning,
    ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    canDisableThinking
  };
}

/**
 * Parse one upstream catalog row's billing metadata.
 *
 * @param {object} row
 * @param {string[]} [extraTags] - badges recovered from the console document.
 * @returns {{credits?: string, badges?: string[], free: boolean}}
 */
export function resolveUpstreamBilling(row, extraTags) {
  const raw = row.credits;
  const credits = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
  const badges = [];
  const tags = [...(Array.isArray(row.tags) ? row.tags : []), ...(extraTags ?? [])];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
    const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length);
    if (label !== '' && !badges.includes(label)) badges.push(label);
  }
  const multiplier = normalizeCredits(credits);
  const free = multiplier !== undefined && /^x?0\.0+$/u.test(multiplier);
  return {
    ...(credits === undefined ? {} : { credits }),
    ...(badges.length === 0 ? {} : { badges }),
    free
  };
}

/**
 * Parse the product document into catalog rows.
 *
 * Membership is the `cli` agent's roster intersected with the usable rows: the
 * document lists models the desktop app can drive, including ones that no
 * command-line-shaped request may use, and `agents[name=cli].models` is the
 * authoritative statement of the intersection.
 *
 * @param {object} data - the envelope's `data`, or the document itself.
 * @param {string[]} [promoBadges] - badge tags by model id, from the console read.
 * @returns {object[]}
 */
export function parseModelCatalog(data, promoBadges) {
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const agents = Array.isArray(data.agents) ? data.agents : [];
  let cliIds;
  for (const agent of agents) {
    if (!isObject(agent)) continue;
    if (agent.name === 'cli' && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((id) => typeof id === 'string');
      break;
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('workbuddy: the model catalog lists no cli agent models');
  }
  const byId = new Map();
  for (const model of rawModels) {
    if (!isObject(model)) continue;
    const id = typeof model.id === 'string' ? model.id : '';
    if (id === '' || model.disabled === true) continue;
    const input = typeof model.maxInputTokens === 'number' ? model.maxInputTokens : 0;
    const output = typeof model.maxOutputTokens === 'number' ? model.maxOutputTokens : 0;
    // A row without both ceilings is not a usable choice: the harness rejects a
    // context window it cannot read, so such a row would create a dead entry.
    if (!positive(input) || !positive(output)) continue;
    byId.set(id, {
      id,
      name: typeof model.name === 'string' && model.name !== '' ? model.name : id,
      contextWindow: input,
      maxTokens: output,
      reasoning: resolveUpstreamReasoning(model),
      billing: resolveUpstreamBilling(model, promoBadges?.get(id))
    });
  }
  const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== undefined);
  if (models.length === 0) throw new Error('workbuddy: the model catalog resolved to an empty list');
  return models;
}

/**
 * Read the console document's promotional tags, by model id.
 *
 * A best-effort second request: a badge is a label on a price, so failing to read
 * it must not fail the catalog. Every failure returns `undefined` and the models
 * simply ship without badges.
 *
 * @param {object} credential
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<string, string[]> | undefined>}
 */
async function fetchPromoBadges(credential, signal) {
  try {
    const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA
      },
      signal: combineSignal(signal)
    });
    if (!response.ok) return undefined;
    const envelope = await readEnvelope(response);
    const data = isObject(envelope.data) ? envelope.data : envelope.document;
    const rawModels = Array.isArray(data.models) ? data.models : [];
    const badges = new Map();
    for (const model of rawModels) {
      if (!isObject(model)) continue;
      const id = typeof model.id === 'string' ? model.id : '';
      if (id === '') continue;
      const tags = Array.isArray(model.tags)
        ? model.tags.filter((tag) => typeof tag === 'string' && tag.toLowerCase().startsWith(BADGE_PREFIX))
        : [];
      if (tags.length > 0) badges.set(id, tags);
    }
    return badges.size === 0 ? undefined : badges;
  } catch {
    return undefined;
  }
}

/** Layer a caller's signal under a timeout, when there is one. */
function combineSignal(signal) {
  const timeout = AbortSignal.timeout(JSON_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * The shape of a chat-stream outcome, successful or not.
 *
 * The message is written to be read by the person who hit it. A free-tier account
 * spends a lot of its time in the upstream's queue, and "upstream soft_rate" tells
 * that person nothing they can act on — so a queued rejection is described as a
 * queue, with the position and the wait the upstream itself reported.
 */
export class UpstreamFailure extends Error {
  /**
   * @param {string} kind
   * @param {number} status
   * @param {string} detail
   */
  constructor(kind, status, detail) {
    super(describeFailure(kind, status, detail));
    this.name = 'UpstreamFailure';
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    /** Seconds the upstream asked the caller to wait, when it said. */
    this.retryAfterSec = kind === 'soft_rate' ? readRetryAfter(detail) : undefined;
  }
}

/**
 * Turn a classified failure into a sentence.
 *
 * @param {string} kind
 * @param {number} status
 * @param {string} detail
 * @returns {string}
 */
export function describeFailure(kind, status, detail) {
  const fallback = extractDisplayErrorMessage(detail);
  if (kind === 'soft_rate') {
    const queue = readQueue(detail);
    if (queue !== undefined) {
      const wait = queue.estimatedWaitMs === undefined ? '' : `, about ${Math.round(queue.estimatedWaitMs / 1000)}s`;
      return (
        `workbuddy: the free-tier queue is ahead of this request (position ${queue.position}` +
        `${queue.size === undefined ? '' : ` of ${queue.size}`}${wait})` +
        `${queue.retryAfterSec === undefined ? '' : ` — retry in ${queue.retryAfterSec}s`}`
      );
    }
    return `workbuddy: the account is rate limited (http ${status})${fallback === undefined ? '' : `: ${fallback}`}`;
  }
  if (kind === 'hard_credit') {
    return `workbuddy: the account is out of credit${fallback === undefined ? '' : ` — ${fallback}`}`;
  }
  if (kind === 'cancelled') {
    // Nothing to act on: the caller stopped this turn on purpose. Reporting it as
    // an upstream fault would send the user looking for a problem that is not
    // there, and would invite a retry of work they just cancelled.
    return 'workbuddy: the request was cancelled';
  }
  if (kind === 'session_dead') {
    return 'workbuddy: the stored sign-in is no longer valid — sign in again in the WorkBuddy app';
  }
  return (
    `workbuddy: the upstream rejected the request (${kind}, http ${status})` +
    `${fallback === undefined ? `: ${detail.slice(0, 200)}` : `: ${fallback}`}`
  );
}

/**
 * The queue fields the upstream reports while a free-tier request waits.
 *
 * @param {string} detail
 * @returns {{position: number, size?: string, retryAfterSec?: number, estimatedWaitMs?: number} | undefined}
 */
function readQueue(detail) {
  const trimmed = String(detail ?? '').trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !isObject(parsed.data)) return undefined;
  const data = parsed.data;
  if (typeof data.queue_position !== 'number') return undefined;
  return {
    position: data.queue_position,
    ...(typeof data.queue_size === 'string' ? { size: data.queue_size } : typeof data.queue_size === 'number' ? { size: String(data.queue_size) } : {}),
    ...(typeof data.retry_after === 'number' ? { retryAfterSec: data.retry_after } : {}),
    ...(typeof data.estimated_wait === 'number' ? { estimatedWaitMs: data.estimated_wait } : {})
  };
}

/**
 * How long the upstream asked the caller to wait.
 *
 * @param {string} detail
 * @returns {number | undefined} seconds.
 */
function readRetryAfter(detail) {
  return readQueue(detail)?.retryAfterSec;
}

/**
 * Whether a thrown transport error is the caller's own cancellation.
 *
 * `fetch` reports an abort as a `DOMException` named `AbortError` (or as whatever
 * the platform's `AbortSignal` produced), and the caller's own signal is the
 * authority: it is aborted exactly when that caller cancelled. Both are checked
 * because a driver is also reached from tests and scripts whose signal may be a
 * bare `AbortController` that already fired.
 *
 * @param {unknown} error
 * @param {AbortSignal} [signal]
 * @returns {boolean}
 */
function isCancellation(error, signal) {
  if (signal?.aborted === true) return true;
  const name = /** @type {{name?: unknown}} */ (error)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = /** @type {{code?: unknown}} */ (error)?.code;
  return code === 'ABORT_ERR';
}

/**
 * The WorkBuddy upstream client.
 *
 * One instance serves every call; the credential is passed per request so a
 * refresh applies on the next one without any state here.
 */
export class UpstreamClient {
  #region;
  #logger;

  /**
   * @param {object} [options]
   * @param {string} [options.region] - `cn` or `global`.
   * @param {{debug?: Function, warn?: Function}} [options.logger]
   */
  constructor(options = {}) {
    this.#region = options.region ?? VARIANT.region;
    this.#logger = options.logger;
  }

  /** The region this client speaks to. */
  get region() {
    return this.#region;
  }

  /**
   * POST the chat endpoint.
   *
   * A successful answer is the raw SSE response: the upstream streams
   * OpenAI-compatible deltas, and this plugin forwards them to the caller rather
   * than re-encoding them.
   *
   * @param {object} credential
   * @param {object} body - the prepared request body.
   * @param {AbortSignal} [signal]
   * @returns {Promise<Response>}
   * @throws {UpstreamFailure}
   */
  async chatStream(credential, body, signal) {
    const region = regionOf(credential.domain);
    const userAgent = chatUserAgent(region);
    const clientVersion = region === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION;
    let response;
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: {
          ...chatHeaders(credential, userAgent, clientVersion),
          Authorization: `Bearer ${credential.accessToken}`
        },
        body: JSON.stringify(prepareChatBody(body, region)),
        ...(signal === undefined ? {} : { signal })
      });
    } catch (error) {
      // A caller who pressed stop did not hit an upstream fault, and reporting one
      // is not a cosmetic problem: `kind` decides whether the harness retries, so
      // a cancellation classified as `server` can be re-sent. The cancellation is
      // rethrown as the abort it is, with no invented status code.
      if (isCancellation(error, signal)) {
        throw new UpstreamFailure('cancelled', 0, 'the caller cancelled the request');
      }
      throw new UpstreamFailure('server', 0, `transport error: ${String(error)}`);
    }
    if (response.ok) return response;
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
    throw new UpstreamFailure(classifyUpstreamError(response.status, text), response.status, text);
  }

  /**
   * POST the token-refresh endpoint.
   *
   * @param {object} credential
   * @returns {Promise<{accessToken: string, refreshToken?: string, expiresInSec?: number, domain?: string}>}
   */
  async refreshToken(credential) {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const data = isObject(envelope.data) ? envelope.data : {};
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
    if (accessToken === '') {
      throw new Error('workbuddy: token refresh returned no accessToken; sign in again in the WorkBuddy app');
    }
    const outcome = { accessToken };
    if (typeof data.refreshToken === 'string' && data.refreshToken !== '') outcome.refreshToken = data.refreshToken;
    if (typeof data.expiresIn === 'number' && data.expiresIn > 0) outcome.expiresInSec = data.expiresIn;
    if (typeof data.domain === 'string' && data.domain !== '') outcome.domain = data.domain;
    return outcome;
  }

  /**
   * GET the product document and parse it into catalog rows.
   *
   * @param {object} credential
   * @param {AbortSignal} [signal]
   * @returns {Promise<object[]>}
   */
  async fetchModels(credential, signal) {
    const region = regionOf(credential.domain);
    const international = region === 'global';
    const response = await fetch(`${chatBase(credential)}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: 'application/json',
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...(international ? { 'X-Requested-With': 'XMLHttpRequest', 'X-Product': 'SaaS' } : {}),
        'User-Agent': international ? appUserAgent(FALLBACK_APP_VERSION) : CLIENT_UA
      },
      signal: combineSignal(signal)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
    const document = isObject(envelope.data)
      ? envelope.data
      : 'models' in envelope.document || 'agents' in envelope.document
        ? envelope.document
        : {};
    const badges = international ? undefined : await fetchPromoBadges(credential, signal);
    return parseModelCatalog(document, badges);
  }

  /**
   * POST the billing endpoint for the aggregated remaining credit.
   *
   * Two upstream shapes exist and are chosen by account type. An enterprise
   * account gets a single cycle quota; everyone else gets a package list. The
   * region gate matters: the enterprise endpoint is only verified for CN, so an
   * international credential that happens to carry an enterprise id stays on the
   * measured personal path.
   *
   * @param {object} credential
   * @returns {Promise<{total: number, accounts: object[], unlimited?: boolean, cycleResetTime?: string, expiry?: object}>}
   */
  async fetchCredits(credential) {
    if (regionOf(credential.domain) === 'cn' && credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
      return this.#fetchEnterpriseCredits(credential);
    }
    const now = new Date();
    const format = (date) =>
      `${[date.getFullYear().toString().padStart(4, '0'), (date.getMonth() + 1).toString().padStart(2, '0'), date.getDate().toString().padStart(2, '0')].join('-')} ${[
        date.getHours().toString().padStart(2, '0'),
        date.getMinutes().toString().padStart(2, '0'),
        date.getSeconds().toString().padStart(2, '0')
      ].join(':')}`;
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);

    const wrapper = isObject(envelope.data) ? envelope.data : {};
    const data = isObject(wrapper.Response) ? wrapper.Response : {};
    const inner = isObject(data.Data) ? data.Data : {};
    const rawAccounts = Array.isArray(inner.Accounts) ? inner.Accounts : [];
    const accounts = [];
    let total = 0;
    for (const raw of rawAccounts) {
      if (!isObject(raw)) continue;
      const numberField = (key) => (typeof raw[key] === 'number' ? raw[key] : 0);
      const size = numberField('CycleCapacitySize');
      const cycleRemain = numberField('CycleCapacityRemain');
      const cycleUsed = numberField('CycleCapacityUsed');
      let remain;
      if (size > 0) remain = cycleRemain;
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
      else remain = numberField('CapacityRemain');
      if (remain < 0) remain = 0;
      total += remain;
      const endTimeMs = parseCycleEndTime(raw.CycleEndTime);
      accounts.push({
        packageName: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
        remain,
        size: size > 0 ? size : numberField('CapacitySize'),
        ...(endTimeMs === undefined ? {} : { endTimeMs })
      });
    }
    return { total, accounts };
  }

  /**
   * CN enterprise credit read: a single cycle quota instead of a package list.
   *
   * A body carrying no recognisable quota field is a hard error rather than a
   * zero. Rendering `0` for "this answer was not understood" is how a plausible
   * wrong number reaches the user, which is worse than a visible failure.
   */
  async #fetchEnterpriseCredits(credential) {
    const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);

    const sources = [];
    for (const candidate of [envelope.data, envelope.document]) {
      if (!isObject(candidate)) continue;
      if (isObject(candidate.data)) sources.push(candidate.data);
      sources.push(candidate);
    }
    const numberAt = (source, key) => (typeof source[key] === 'number' ? source[key] : undefined);
    let limit;
    let used;
    let resetTime;
    for (const source of sources) {
      const candidate = numberAt(source, 'limitNum') ?? numberAt(source, 'limit_num');
      if (candidate === undefined) continue;
      limit = candidate;
      used = numberAt(source, 'credit') ?? numberAt(source, 'used_num');
      if (typeof source.cycleResetTime === 'string' && source.cycleResetTime !== '') resetTime = source.cycleResetTime;
      break;
    }
    if (limit === undefined) {
      throw new Error('workbuddy: the enterprise billing response carried no recognised quota field');
    }
    if (limit === -1) {
      return {
        total: 0,
        accounts: [{ packageName: 'enterprise', remain: 0, size: 0, unlimited: true }],
        unlimited: true,
        ...(resetTime === undefined ? {} : { cycleResetTime: resetTime })
      };
    }
    if (used === undefined) {
      throw new Error('workbuddy: the enterprise billing response carried a quota limit but no usage field');
    }
    const remain = Math.max(0, limit - used);
    return {
      total: remain,
      accounts: [{ packageName: 'enterprise', remain, size: limit }],
      ...(resetTime === undefined ? {} : { cycleResetTime: resetTime })
    };
  }
}

/**
 * Parse the billing response's zone-less `CycleEndTime`.
 *
 * The value is read as the running machine's local time, which is what the
 * official desktop client does with the same field. That makes this agree with the
 * app on the same machine; it is not evidence about which zone the account uses,
 * so no offset is invented.
 *
 * @param {unknown} value
 * @returns {number | undefined} epoch milliseconds.
 */
export function parseCycleEndTime(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  const parsed = date.getTime();
  if (!Number.isFinite(parsed)) return undefined;
  // A round-trip check, so a value like `02-31` is rejected rather than silently
  // rolled over into March.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return undefined;
  }
  return parsed;
}
