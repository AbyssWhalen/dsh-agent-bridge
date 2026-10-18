/**
 * Browser half of dsh-agent-bridge: the components page.
 *
 * This file is loaded by the harness as a plain module-table entry, not built by
 * a bundler, so it is written in the module-loader form directly: one `load` call,
 * one factory, `react` and `react/jsx-runtime` taken from the page's own table.
 * There is no duplicate React and nothing to compile.
 *
 * The page exists because a bundled reverse proxy is only honest if the user can
 * see what it is actually serving. Every number below comes from the host's status
 * route, which builds it from the same catalog the model picker reads — so the page
 * cannot claim a model the picker would not offer, and an empty vendor reads as
 * empty rather than as a fault.
 *
 * The switch is per vendor and the host honours it for real: turning one off
 * releases that vendor's provider route, stops its timer, and closes its sessions.
 * The other two keep running untouched, which is the point — a vendor whose free
 * allowance ends can be retired without disturbing the rest.
 *
 * The switch dsh itself draws wins where it exists. Each vendor is a row in
 * `cordis.patch.yml`, so «包含的组件» on the package page lists three rows with three
 * switches, and this file contributes the page behind each row's chevron plus the
 * bundle page that puts the three together. Two switches for one vendor would be
 * two truths, so the panel here draws no on/off control on a row's own page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-bridge',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    var react = require('react');
    var jsx = require('react/jsx-runtime');
    var h = react.createElement;

    /** Locale namespace for this page's copy. */
    var NAMESPACE = 'settings.agent-bridge';

    /**
     * The route prefix the host mounts. Kept literal so a host change is one
     * visible edit, and mirrored in `lib/routes.js`'s `pathsFor`.
     */
    var ROUTE_PREFIX = '/plugins/dsh-agent-bridge';

    /**
     * The status and action route for one vendor.
     *
     * Every vendor always has its own pair: a three-row profile mounts one
     * instance per row and each answers only for itself, and a single-row profile
     * mounts one instance that answers for each vendor under the same paths. So the
     * page can address a vendor by name either way, and a row's page reads exactly
     * the state it owns instead of picking its vendor out of a wider document.
     *
     * The aggregate pair (`…/status`) is what a one-row profile's bundle page used
     * before the rows existed; it is still served, and nothing here needs it.
     */
    function pathsFor(componentId) {
      var base = componentId === undefined ? ROUTE_PREFIX : ROUTE_PREFIX + '/' + componentId;
      return { status: base + '/status', action: base + '/action' };
    }

    var KEY_HEADER = 'x-agent-bridge-key';

    /** How often an open page re-reads the status document. */
    var POLL_MS = 15000;

    /**
     * One extra read after an action, in ms.
     *
     * Switching a vendor on starts work that outlives the answer: a worker
     * handshake, a token refresh, a model enumeration. The status that comes back
     * with the action is already the best the host can wait for, but a driver that
     * takes longer would leave "no models" on screen until the next poll. One
     * follow-up read closes that gap without shortening the poll.
     */
    var FOLLOW_UP_MS = 2500;

    /**
     * The slot a bundle row's own page registers under.
     *
     * `plugins.bundle.config` is the package page; `plugins.row.config` is the page
     * a chevron on one row of «包含的组件» opens. That is the shape the user asked
     * for: one package whose page lists three components, each with its own switch
     * and its own detail page.
     */
    var ROW_SLOT = 'plugins.row.config';

    /**
     * Prefix of a row id.
     *
     * DSH keys a row's page by `<bundle>#<rowId>`, and the row id comes from
     * `cordis.patch.yml`. Deriving it from the vendor id keeps the two files in
     * step: a fourth vendor added to `COMPONENTS` gets a page the moment its row
     * exists, and cannot silently miss one.
     */
    var ROW_PREFIX = 'agent-bridge-';

    /**
     * How each vendor describes itself on the page.
     *
     * `fields` names the account facts worth showing, in order. A driver that
     * reports something else is not hidden — unknown keys are summarised at the
     * end — but the named ones get a label a user can read.
     */
    var COMPONENTS = {
      workbuddy: {
        title: 'WorkBuddy',
        vendor: 'WorkBuddy 桌面端',
        // The driver reports a package balance but no unit, because the number is
        // the only thing the upstream states; "credits" is what WorkBuddy itself
        // calls them, so the page can say it without inventing a conversion.
        unit: 'credits',
        blurb: '读取 WorkBuddy 桌面端已登录账号的模型与积分。',
        fields: [
          ['installed', '已安装'],
          ['version', '版本'],
          ['signedIn', '已登录'],
          ['account', '账号'],
          ['nickname', '昵称']
        ]
      },
      qoder: {
        title: 'Qoder',
        vendor: 'Qoder CN',
        blurb: '读取 Qoder 桌面端已登录账号的模型与额度。',
        fields: [
          ['installed', '已安装'],
          ['version', '版本'],
          ['signedIn', '已登录'],
          ['account', '账号']
        ]
      }
    };

    /** The copy the page renders in each supported language. */
    var zh = {
      intro: '把几家 AI 桌面端里已经登录的账号模型转发进 DSH。每个组件可以单独开启、关闭或卸载，互不影响。',
      loading: '正在读取状态…',
      loadFailed: '读取状态失败',
      retry: '重试',
      on: '已开启',
      off: '已关闭',
      removed: '已卸载',
      failed: '无法启动',
      enable: '开启',
      disable: '关闭',
      uninstall: '卸载',
      restoring: '恢复中…',
      restore: '恢复',
      refresh: '刷新',
      refreshing: '刷新中…',
      confirmUninstall: '卸载会把该组件的驱动文件移出插件目录，之后可以恢复。确定卸载？',
      accountHeading: '账号',
      modelsHeading: '模型',
      modelsEmpty: '当前没有可用模型',
      quotaHeading: '额度',
      quotaNone: '没有额度信息',
      modelsCount: '{count} 个模型',
      remaining: '剩余 {remain} / {size}',
      exhausted: '额度已用尽',
      resets: '到期 {time}',
      noData: '—',
      yes: '是',
      no: '否',
      lastRead: '读取于 {time}',
      reasonLabel: '原因',
      parkedHint: '驱动文件已移出插件目录；恢复后可以重新开启。',
      offHint: '已关闭，不占用任何资源。开启后立即挂载。',
      summaryOffHint: '不占用资源',
      summaryRemovedHint: '驱动已移出，可恢复',
      switchInList: '开关就是上面「包含的组件」里这一行自己的开关，关掉即停、开开即挂载。',
      tabStatus: '概览',
      tabModels: '模型',
      tabAccount: '账号',
      expand: '展开',
      collapse: '收起',
      signedInLine: '已登录',
      signedOutLine: '未登录',
      versionPrefix: '版本 {version}',
      creditsLeft: '剩余 {total}',
      creditsGranted: '共 {total}',
      creditsUnit: '额度',
      packagesAvailable: '还有 {count} 个可用权益包',
      packagesSpent: '另有 {count} 个权益包已用尽',
      packageUnknownSize: '剩余 {remain}（总额未知）',
      remainingPercent: '剩余 {percent}%',
      modelsScrollHint: '读的是模型选择器同一份 catalog',
      effortChip: '思考 {efforts}',
      thinkingToggle: '思考 开/关',
      noModelsShort: '0 个模型',
      usedAmount: '已用 {used}',
      ctxCompact: '{size} 上下文',
      outCompact: '输出 {size}',
      stateNote: 'DSH 的模型选择器只显示有模型的组，所以关闭或没有额度的组件不会出现在里面。'
    };

    var en = {
      intro: 'Reverse-proxies the models of already signed-in AI desktop clients into DSH. Each component switches off, on, or away independently.',
      loading: 'Reading status…',
      loadFailed: 'Could not read status',
      retry: 'Retry',
      on: 'On',
      off: 'Off',
      removed: 'Uninstalled',
      failed: 'Failed to start',
      enable: 'Enable',
      disable: 'Disable',
      uninstall: 'Uninstall',
      restoring: 'Restoring…',
      restore: 'Restore',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      confirmUninstall: 'Uninstalling moves this component\u2019s driver files out of the plugin directory. It can be restored later. Continue?',
      accountHeading: 'Account',
      modelsHeading: 'Models',
      modelsEmpty: 'No models available right now',
      quotaHeading: 'Allowance',
      quotaNone: 'No allowance data',
      modelsCount: '{count} models',
      remaining: '{remain} / {size} left',
      exhausted: 'Allowance exhausted',
      resets: 'Expires {time}',
      noData: '—',
      yes: 'Yes',
      no: 'No',
      lastRead: 'Read at {time}',
      reasonLabel: 'Reason',
      parkedHint: 'Driver files were moved out of the plugin directory; restore to enable again.',
      offHint: 'Switched off; using nothing. Enabling mounts it immediately.',
      summaryOffHint: 'using nothing',
      summaryRemovedHint: 'driver files parked; restorable',
      switchInList: 'This row\u2019s switch is the one on its line under \u00abContained components\u00bb: off stops it, on mounts it.',
      tabStatus: 'Overview',
      tabModels: 'Models',
      tabAccount: 'Account',
      expand: 'Expand',
      collapse: 'Collapse',
      signedInLine: 'Signed in',
      signedOutLine: 'Signed out',
      versionPrefix: 'version {version}',
      creditsLeft: '{total} left',
      creditsGranted: '{total} granted',
      creditsUnit: 'Allowance',
      packagesAvailable: '{count} more package(s) available',
      packagesSpent: '{count} more package(s) spent',
      packageUnknownSize: '{remain} left (total unknown)',
      remainingPercent: '{percent}% left',
      modelsScrollHint: 'same catalog the model picker reads',
      effortChip: 'thinking {efforts}',
      thinkingToggle: 'thinking on/off',
      noModelsShort: '0 models',
      usedAmount: '{used} used',
      ctxCompact: '{size} ctx',
      outCompact: '{size} out',
      stateNote: 'DSH\u2019s model picker hides a group with no models, so a switched-off or unentitled component simply does not appear there.'
    };

    /** Substitute `{name}` placeholders without pulling in a format library. */
    function format(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
      );
    }

    /** Compact a large token count the way the picker does. */
    function size(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      if (value >= 1000000) return `${(value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1)}M`;
      if (value >= 1000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
      return String(value);
    }

    /** Format a credit count with thousands separators. */
    function count(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return Number.isInteger(value)
        ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
        : String(Math.round(value * 100) / 100);
    }

    /** Format a millisecond timestamp in the reader's own zone. */
    function time(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      try {
        return new Date(value).toLocaleString();
      } catch {
        return null;
      }
    }

    /* ------------------------------------------------------------- read views */

    /**
     * The copy table for the language in effect.
     *
     * The page sets the store's language when it mounts, but a card in the Plugins
     * list renders before that page has ever been opened. Falling back to the
     * browser's own language is what keeps a list built at boot from being
     * Chinese-only on an English UI.
     */
    function copyFor(store) {
      var language = store === undefined ? undefined : store.getSnapshot().language;
      if (language === undefined) {
        language =
          typeof navigator === 'undefined' || typeof navigator.language !== 'string'
            ? 'zh'
            : navigator.language.slice(0, 2).toLowerCase();
      }
      return language === 'en' ? en : zh;
    }

    /** One copy key from the table in effect. */
    function translateFor(store, key) {
      var table = copyFor(store);
      return table[key] === undefined ? key : table[key];
    }

    /** The vendor a status document describes, or `undefined` before the first read. */
    function componentFrom(snapshot, id) {
      var document = snapshot === undefined ? undefined : snapshot.document;
      if (document === undefined || !Array.isArray(document.components)) return undefined;
      for (var index = 0; index < document.components.length; index++) {
        if (document.components[index].id === id) return document.components[index];
      }
      return undefined;
    }

    /**
     * The balance as one phrase, in whichever shape the vendor reports it.
     *
     * Two shapes reach here: a list of packages, and a used/total pair. A vendor
     * with no balance at all returns `null`, which is how the caller knows to say
     * nothing rather than to say zero.
     */
    function quotaPhrase(quota, fallbackUnit) {
      if (typeof quota !== 'object' || quota === null) return null;
      var unit =
        typeof quota.unit === 'string' ? ' ' + quota.unit : typeof fallbackUnit === 'string' ? ' ' + fallbackUnit : '';
      if (Array.isArray(quota.accounts) && quota.accounts.length > 0) {
        var total = count(quota.total);
        return total === null ? null : total + unit;
      }
      if (typeof quota.remaining === 'number') {
        var remain = count(quota.remaining);
        var sizeText = count(quota.total);
        return sizeText === null ? remain + unit : remain + ' / ' + sizeText + unit;
      }
      return null;
    }

    /** The unit a component's figures are counted in, as a leading-space suffix. */
    function unitSuffix(component) {
      if (typeof component.quota === 'object' && component.quota !== null && typeof component.quota.unit === 'string') {
        return ' ' + component.quota.unit;
      }
      var spec = COMPONENTS[component.id];
      return spec !== undefined && typeof spec.unit === 'string' ? ' ' + spec.unit : '';
    }

    /**
     * The one line a card in the Plugins list shows under its name.
     *
     * It is the whole point of the card: the switch is one click away, but whether
     * the vendor is serving anything, and how much allowance is left, has to be
     * readable without opening it.
     */
    function summaryLine(store, component) {
      var t = function (key) {
        return translateFor(store, key);
      };
      if (component === undefined) return t('loading');
      if (component.state === 'removed') return t('removed') + ' · ' + t('summaryRemovedHint');
      if (component.state !== 'on') return t('off') + ' · ' + t('summaryOffHint');
      if (typeof component.reason === 'string') return t('failed') + ' · ' + component.reason;
      var parts = [t('on')];
      var models = Array.isArray(component.models) ? component.models.length : 0;
      // `noModelsShort` rather than the long explanation: the summary is a header
      // line, and the full sentence belongs in the section that has room for it.
      parts.push(models === 0 ? t('noModelsShort') : format(t('modelsCount'), { count: models }));
      var balance = quotaPhrase(component.quota, COMPONENTS[component.id] && COMPONENTS[component.id].unit);
      if (balance !== null) parts.push(format(t('creditsLeft'), { total: balance }));
      return parts.join(' · ');
    }

    /* ---------------------------------------------------------------- styles */

    /**
     * The visual vocabulary, borrowed whole from `dsh-workbuddy-connect`.
     *
     * That plugin is the established shape for a provider's own settings surface in
     * this harness, and it is one page of prose I intentionally do not re-invent:
     * 14px semibold titles over a 13px tertiary subline, a collapsible card on
     * `bg-module-platform` with a hairline header, a tab strip whose active tab is a
     * 2px brand underline, 8px progress tracks for allowances, and 13px rows that
     * put the label left and the number right. The only tokens used are theme
     * aliases, so light and dark both work and nothing here hard-codes a colour.
     *
     * What this replaced was a single flat list at 11–12px where three vendors,
     * seventy-eight billing packages and forty models all landed in one column at
     * one weight. The fix is not decoration: it is grouping (one card per vendor),
     * ordering (the number you opened the page for sits in the header), and
     * restraint (packages that are already spent do not get a row).
     */
    var pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      listStyle: 'none',
      margin: 0,
      padding: 0
    };

    var blurbStyle = {
      margin: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-tertiary)'
    };

    /** One vendor: a card whose header is the summary and whose body is the detail. */
    var cardStyle = {
      overflow: 'hidden',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-module-platform)',
      listStyle: 'none'
    };

    var headerStyle = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      border: 0,
      padding: '13px 14px',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      textAlign: 'left',
      cursor: 'pointer'
    };

    var headTextStyle = {
      display: 'flex',
      minWidth: 0,
      flex: '1 1 auto',
      flexDirection: 'column',
      gap: 3
    };

    var nameStyle = {
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)'
    };

    var descriptionStyle = {
      fontSize: 13,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
      overflowWrap: 'anywhere'
    };

    /**
     * A row page's header, which has no name in it.
     *
     * The harness already draws the row's title, `<code>` module name and
     * description above this content, so a card that repeated the name would be the
     * third copy on one screen. What is left is the summary — the part the harness
     * cannot know — and the collapse control, in a slimmer bar so it reads as a
     * heading for the panel rather than as a second title.
     */
    var headerBarStyle = {
      ...headerStyle,
      padding: '10px 12px',
      background: 'transparent'
    };

    var headerSummaryStyle = {
      ...descriptionStyle,
      color: 'var(--dsw-alias-label-secondary)'
    };

    var chevronStyle = {
      flex: '0 0 auto',
      fontSize: 18,
      lineHeight: 1,
      color: 'var(--dsw-alias-label-tertiary)',
      transition: 'transform 120ms ease'
    };

    var cardBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      borderTop: '1px solid var(--dsw-alias-border-l2)',
      padding: '14px 14px 16px'
    };

    /** The row under the header: what the vendor is logged in as, and the controls. */
    var toolbarStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: 10
    };

    var statusLineStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)'
    };

    var buttonRowStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      flex: '0 0 auto'
    };

    var buttonStyle = {
      boxSizing: 'border-box',
      minHeight: 32,
      padding: '5px 13px',
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: 16,
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      cursor: 'pointer'
    };

    var primaryButtonStyle = {
      ...buttonStyle,
      border: '1px solid var(--dsw-alias-button-primary-fill)',
      background: 'var(--dsw-alias-button-primary-fill)',
      color: 'var(--dsw-alias-label-primary-foreground)'
    };

    /** Tab strip: light on purpose, so it cannot out-shout the section headings. */
    var tabBarStyle = {
      display: 'flex',
      gap: 4,
      borderBottom: '1px solid var(--dsw-alias-border-l2)'
    };

    var tabStyle = {
      padding: '6px 12px',
      border: 0,
      borderBottom: '2px solid transparent',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer'
    };

    var tabActiveStyle = {
      borderBottom: '2px solid var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-label-primary)',
      fontWeight: 600
    };

    var tabPanelStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      paddingTop: 14
    };

    var sectionStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 9
    };

    var sectionHeadStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      flexWrap: 'wrap'
    };

    var sectionTitleStyle = {
      margin: 0,
      fontSize: 14,
      lineHeight: '20px',
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)'
    };

    var sectionMetaStyle = {
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)'
    };

    var barGroupStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    };

    /** One allowance row's label line: name left, share right. */
    var barLabelStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)'
    };

    var barTrackStyle = {
      height: 8,
      borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))',
      overflow: 'hidden'
    };

    var barDetailStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)'
    };

    /**
     * The model list: one row per model, label left, capacity right.
     *
     * It scrolls with the page rather than inside a `max-height` box. A nested
     * scroller inside a card inside a scrolling settings page traps the wheel near
     * the top of the card and costs more than it saves; the tab keeps the length
     * bounded anyway, since only one of the three panels is on screen.
     */
    var modelListStyle = {
      display: 'flex',
      flexDirection: 'column',
      margin: 0,
      padding: 0,
      listStyle: 'none'
    };

    var modelRowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: 12,
      padding: '7px 2px',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))'
    };

    var modelMainStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minWidth: 0,
      flexWrap: 'wrap'
    };

    var modelNameStyle = {
      minWidth: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      overflowWrap: 'anywhere'
    };

    var modelMetaStyle = {
      flex: '0 0 auto',
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
      whiteSpace: 'nowrap'
    };

    var chipStyle = {
      padding: '0 7px',
      borderRadius: 999,
      fontSize: 11,
      lineHeight: '17px',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
      color: 'var(--dsw-alias-label-secondary)'
    };

    var gridStyle = {
      display: 'grid',
      gridTemplateColumns: 'max-content minmax(0, 1fr)',
      alignItems: 'baseline',
      gap: '6px 16px',
      margin: 0
    };

    var keyStyle = {
      fontSize: 12,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-tertiary)'
    };

    var valueStyle = {
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      overflowWrap: 'anywhere'
    };

    var noteStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)'
    };

    var errorStyle = {
      ...noteStyle,
      color: 'var(--dsw-alias-state-error-primary)'
    };

    /** A quiet box for a non-error explanation, so it is not part of the data. */
    var noticeStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      padding: '9px 11px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))',
      fontSize: 13,
      lineHeight: '19px',
      color: 'var(--dsw-alias-label-secondary)'
    };

    /**
     * The dot beside a state: green while serving, amber while working, red on
     * failure, grey otherwise. Same read as the components list's own status dot,
     * which is why it is worth drawing here too.
     */
    function stateDotStyle(component) {
      var colour = 'var(--dsw-alias-label-tertiary)';
      if (component.state === 'removed') colour = 'var(--dsw-alias-label-tertiary)';
      else if (component.state !== 'on') colour = 'var(--dsw-alias-label-tertiary)';
      else if (typeof component.reason === 'string') colour = 'var(--dsw-alias-state-error-primary, #d92d20)';
      else colour = 'var(--dsw-alias-state-success-primary, #22a06b)';
      return { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto', background: colour };
    }

    /** The fill of a progress track, clamped so a bad number cannot escape its bar. */
    function barFillStyle(percent) {
      return {
        width: `${Math.max(0, Math.min(100, percent))}%`,
        height: '100%',
        borderRadius: 'inherit',
        background: 'var(--dsw-alias-brand-primary, #1677ff)'
      };
    }

    /* ------------------------------------------------------------ data layer */

    /**
     * Whether a parsed value really is a status document.
     *
     * A 200 is not a promise about the body: it may be empty, `null`, a proxy's
     * HTML error page, or an array. Storing an unreadable value would put
     * something in state that the next render dereferences.
     */
    function isStatusDocument(value) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
      if (!Array.isArray(value.components)) return false;
      return typeof value.key === 'string';
    }

    /**
     * The page's store: one document, polled, with pending flags per action.
     *
     * A plain observable class rather than a reducer keeps the polling and the
     * action queue in one place, which is what stops a poll from overwriting the
     * result of a click that has not been answered yet.
     *
     * @param {{status: string, action: string}} [paths] - the routes this store
     *   reads and writes; one vendor's own pair, or the aggregate pair.
     */
    function createStore(paths) {
      var routes = paths === undefined ? pathsFor(undefined) : paths;
      var listeners = new Set();
      var snapshot = { status: 'loading', document: undefined, error: undefined, busy: undefined, actionError: undefined };
      var timer;
      var controller;
      var disposed = false;

      function emit() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch {
            /* a crashed subscriber must not stop the others */
          }
        });
      }

      function set(next) {
        snapshot = Object.assign({}, snapshot, next);
        emit();
      }

      async function load() {
        controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        try {
          var response = await fetch(routes.status, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller === undefined ? undefined : controller.signal
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          var body = await response.json();
          if (!isStatusDocument(body)) throw new Error('unreadable status document');
          if (disposed) return;
          set({ status: 'ready', document: body, error: undefined });
        } catch (error) {
          if (disposed || (error && error.name === 'AbortError')) return;
          // A failed poll keeps the last good document on screen: a blip must not
          // turn a page that was working into an error page.
          set({
            status: snapshot.document === undefined ? 'failed' : 'stale',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }

      async function act(action, component) {
        var key = snapshot.document === undefined ? undefined : snapshot.document.key;
        if (key === undefined) return;
        if (action === 'uninstall' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(store.t('confirmUninstall'))) return;
        }
        set({ busy: action + ':' + component, actionError: undefined });
        try {
          var response = await fetch(routes.action, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              [KEY_HEADER]: key
            },
            body: JSON.stringify({ action: action, component: component })
          });
          var body = await response.json().catch(function () {
            return undefined;
          });
          if (!response.ok) {
            throw new Error((body && body.error) || 'HTTP ' + response.status);
          }
          if (disposed) return;
          var next = body && isStatusDocument(body.status) ? body.status : snapshot.document;
          set({
            status: 'ready',
            document: next,
            busy: undefined,
            actionError: body && body.ok === false ? body.reason || 'failed' : undefined
          });
        } catch (error) {
          if (disposed) return;
          set({
            busy: undefined,
            actionError: error instanceof Error ? error.message : String(error)
          });
        }
        await load();
        if (disposed || typeof setTimeout !== 'function') return;
        var followUp = setTimeout(function () {
          void load();
        }, FOLLOW_UP_MS);
        // A pending timer must not keep a non-browser caller alive.
        if (followUp !== null && typeof followUp === 'object' && typeof followUp.unref === 'function') {
          followUp.unref();
        }
      }

      var store = {
        t: function (key) {
          var table = snapshot.language === 'en' ? en : zh;
          return table[key] === undefined ? key : table[key];
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        getSnapshot: function () {
          return snapshot;
        },
        setLanguage: function (language) {
          if (snapshot.language === language) return;
          set({ language: language });
        },
        start: function () {
          load();
          timer = setInterval(load, POLL_MS);
          return function () {
            disposed = true;
            clearInterval(timer);
            if (controller !== undefined) controller.abort();
            listeners.clear();
          };
        },
        act: act,
        reload: load
      };
      return store;
    }

    /* --------------------------------------------------------------- views */

    /** The account facts this vendor reports, as a two-column definition list. */
    function AccountSection({ t, component, spec }) {
      var located = component.located;
      var head = h(
        'div',
        { style: sectionHeadStyle },
        h('h3', { style: sectionTitleStyle }, t('accountHeading')),
        typeof component.displayName === 'string'
          ? h('span', { style: sectionMetaStyle }, component.displayName)
          : null
      );
      if (typeof located !== 'object' || located === null) {
        return h('div', { style: sectionStyle }, head, h('p', { style: noteStyle }, component.locateError || t('noData')));
      }
      var rows = [];
      var known = new Set();
      spec.fields.forEach(function (pair) {
        var key = pair[0];
        var label = pair[1];
        known.add(key);
        if (!Object.prototype.hasOwnProperty.call(located, key)) return;
        var raw = located[key];
        if (raw === undefined || raw === null || raw === '') return;
        var text = typeof raw === 'boolean' ? t(raw ? 'yes' : 'no') : String(raw);
        rows.push([label, text]);
      });
      // Anything the driver reports that the spec does not name still shows up,
      // so a driver that grows a field is visible without a client change.
      Object.keys(located).forEach(function (key) {
        if (known.has(key) || key === 'reason') return;
        var raw = located[key];
        if (raw === undefined || raw === null || raw === '') return;
        if (typeof raw === 'object') return;
        rows.push([key, typeof raw === 'boolean' ? t(raw ? 'yes' : 'no') : String(raw)]);
      });
      if (typeof located.reason === 'string') rows.push([t('reasonLabel'), located.reason]);
      if (rows.length === 0) return h('div', { style: sectionStyle }, head, h('p', { style: noteStyle }, t('noData')));
      return h(
        'div',
        { style: sectionStyle },
        head,
        h(
          'dl',
          { style: gridStyle },
          rows.map(function (row, index) {
            return h(
              'div',
              { key: index, style: { display: 'contents' } },
              h('dt', { style: keyStyle }, row[0]),
              h('dd', { style: { ...valueStyle, margin: 0 } }, row[1])
            );
          })
        )
      );
    }

    /**
     * One allowance bar: a label line, a track, and the exact figures under it.
     *
     * A package whose total the upstream never reported gets an empty track rather
     * than a full one: filling it would claim a share nothing measured, which is
     * the opposite of the honest "N left" printed underneath.
     */
    function AllowanceBar({ t, label, remain, size, detail }) {
      var sizeKnown = typeof size === 'number' && Number.isFinite(size) && size > 0;
      var percent = sizeKnown ? (remain / size) * 100 : undefined;
      var share = percent === undefined ? t('noData') : format(t('remainingPercent'), { percent: Math.round(percent * 10) / 10 });
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('div', { style: barLabelStyle }, h('span', null, label), h('span', null, share)),
        h(
          'div',
          {
            style: barTrackStyle,
            role: 'progressbar',
            'aria-label': label,
            ...(percent === undefined
              ? { 'aria-valuetext': detail }
              : { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(percent) })
          },
          percent === undefined ? null : h('div', { style: barFillStyle(percent) })
        ),
        h('p', { style: barDetailStyle }, detail)
      );
    }

    /**
     * The allowance section, in whichever shape the vendor reports.
     *
     * Two shapes, two layouts, because flattening them into one loses the number a
     * reader wants first:
     *
     *   accounts   WorkBuddy: one bar per package that still has credit, spent
     *              packages summarised as a count. Seventy-eight rows of "0 / 100"
     *              is what made the page unreadable; they carry no decision.
     *   pair       Qoder: one bar over `remaining / total`, with the account type
     *              and the amount already used as the detail line.
     *
     * A driver that reports neither gets `quotaNone`, which is the honest answer:
     * this page never invents a number to fill the space.
     */
    function QuotaSection({ t, component }) {
      var quota = component.quota;
      var heading = h('h3', { style: sectionTitleStyle }, t('quotaHeading'));
      if (typeof quota !== 'object' || quota === null) {
        return h('div', { style: sectionStyle }, h('div', { style: sectionHeadStyle }, heading), h('p', { style: noteStyle }, t('quotaNone')));
      }

      if (Array.isArray(quota.accounts) && quota.accounts.length > 0) {
        var packages = quota.accounts.filter(function (item) {
          return typeof item === 'object' && item !== null;
        });
        var live = packages
          .filter(function (item) {
            return typeof item.remain === 'number' && item.remain > 0;
          })
          .sort(function (a, b) {
            return (b.remain || 0) - (a.remain || 0);
          });
        var total = count(quota.total);
        var spent = packages.length - live.length;
        var shown = live.slice(0, 6);
        return h(
          'div',
          { style: sectionStyle },
          h(
            'div',
            { style: sectionHeadStyle },
            heading,
            total === null ? null : h('span', { style: sectionMetaStyle }, format(t('creditsGranted'), { total: total + unitSuffix(component) }))
          ),
          live.length === 0
            ? h('div', { style: noticeStyle }, h('span', null, t('exhausted')))
            : h(
                'div',
                { style: barGroupStyle },
                shown.map(function (item, index) {
                  var remain = typeof item.remain === 'number' ? item.remain : 0;
                  var packageSize = typeof item.size === 'number' ? item.size : undefined;
                  var expires = time(item.endTimeMs);
                  var figure =
                    packageSize !== undefined && packageSize > 0
                      ? format(t('remaining'), { remain: count(remain), size: count(packageSize) })
                      : format(t('packageUnknownSize'), { remain: count(remain) });
                  return h(AllowanceBar, {
                    key: String(item.packageName || '') + '-' + index,
                    t: t,
                    label: String(item.packageName || t('noData')),
                    remain: remain,
                    size: packageSize,
                    detail: expires === null ? figure : figure + ' · ' + format(t('resets'), { time: expires })
                  });
                })
              ),
          live.length > shown.length
            ? h('p', { style: noteStyle }, format(t('packagesAvailable'), { count: live.length - shown.length }))
            : null,
          spent > 0 ? h('p', { style: noteStyle }, format(t('packagesSpent'), { count: spent })) : null
        );
      }

      if (typeof quota.remaining === 'number') {
        var unit = unitSuffix(component);
        var remaining = count(quota.remaining);
        var capacity = count(quota.total);
        var shareKnown = typeof quota.total === 'number' && quota.total > 0;
        var used = count(quota.used);
        var parts = [format(t('remaining'), { remain: remaining, size: capacity === null ? remaining : capacity })];
        if (used !== null) parts.push(format(t('usedAmount'), { used: used }) + unit);
        return h(
          'div',
          { style: sectionStyle },
          // The heading says "额度" and the plan name labels its one bar. Repeating
          // either word in the head's right-hand slot only adds a second copy of a
          // string that is already on screen.
          h('div', { style: sectionHeadStyle }, heading),
          shareKnown
            ? h(AllowanceBar, {
                t: t,
                label: typeof quota.userType === 'string' ? quota.userType : t('creditsUnit'),
                remain: quota.remaining,
                size: quota.total,
                detail: parts.join(' · ')
              })
            : h('p', { style: { ...valueStyle, margin: 0 } }, parts.join(' · ')),
          quota.exceeded === true ? h('div', { style: noticeStyle }, h('span', null, t('exhausted'))) : null
        );
      }

      return h('div', { style: sectionStyle }, h('div', { style: sectionHeadStyle }, heading), h('p', { style: noteStyle }, t('quotaNone')));
    }

    /**
     * The model list: the facts the picker shows, one line per model.
     *
     * Every model is rendered — the list scrolls instead of truncating, because a
     * truncated catalog would quietly disagree with what the picker offers. Rows
     * are separated by a hairline and the capacity column is flush right, so
     * eighteen of them read as a table rather than as a wall of text.
     */
    function ModelSection({ t, component }) {
      var models = Array.isArray(component.models) ? component.models : [];
      var heading = h(
        'div',
        { style: sectionHeadStyle },
        h('h3', { style: sectionTitleStyle }, t('modelsHeading')),
        h(
          'span',
          { style: sectionMetaStyle },
          models.length === 0 ? t('noModelsShort') : format(t('modelsCount'), { count: models.length })
        )
      );
      if (models.length === 0) {
        return h(
          'div',
          { style: sectionStyle },
          heading,
          h('div', { style: noticeStyle }, h('span', null, t('modelsEmpty')))
        );
      }
      return h(
        'div',
        { style: sectionStyle },
        heading,
        h(
          'ul',
          { style: modelListStyle },
          models.map(function (model, index) {
            var context = size(model.contextWindow);
            var max = size(model.maxTokens);
            var efforts = Array.isArray(model.efforts) && model.efforts.length > 0 ? model.efforts.join('/') : undefined;
            // A model that can only turn thinking off has no level to list, but
            // the picker still offers Default/Off; saying so here keeps the page
            // from looking like the control is missing for that model.
            var thinking =
              efforts === undefined
                ? model.canDisableThinking === true
                  ? t('thinkingToggle')
                  : undefined
                : format(t('effortChip'), { efforts: efforts });
            return h(
              'li',
              { key: String(model.id || index), style: modelRowStyle },
              h(
                'span',
                { style: modelMainStyle },
                h('span', { style: modelNameStyle }, String(model.name || model.id || t('noData'))),
                thinking === undefined ? null : h('span', { style: chipStyle }, thinking)
              ),
              h(
                'span',
                { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flex: '0 0 auto' } },
                h('span', { style: modelMetaStyle }, context === null ? t('noData') : format(t('ctxCompact'), { size: context })),
                max === null
                  ? null
                  : h('span', { style: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary)' } }, format(t('outCompact'), { size: max }))
              )
            );
          })
        ),
        h('p', { style: noteStyle }, t('modelsScrollHint'))
      );
    }

    /**
     * One vendor as a card: a header that answers the question, a body that proves it.
     *
     * The header carries the numbers a reader opens the page for — state, model
     * count, balance — so the card is useful while collapsed, and the body behind it
     * holds the detail split across three tabs instead of one long column. Clicking
     * the header collapses or expands; `defaultOpen` decides which a caller wants: a
     * row's own page opens, the bundle page's three cards start collapsed so the
     * page reads as three summaries rather than three walls.
     *
     * The same tree is the package page's card and the vendor's own page — only the
     * wrapper element differs, because one lives inside a `<ul>` and the other is a
     * section of its own. Two renderings of the same facts would drift.
     */
    function VendorPanel({ t, component, spec, store, busy, element, summary, defaultOpen }) {
      var openState = react.useState(defaultOpen === true);
      var open = openState[0];
      var setOpen = openState[1];
      var tabState = react.useState('status');
      var tab = tabState[0];
      var setTab = tabState[1];

      var state = component.state;
      var isOn = state === 'on';
      var isRemoved = state === 'removed';
      var isFailed = state === 'on' && typeof component.reason === 'string';
      var stateLabel = isRemoved ? t('removed') : isFailed ? t('failed') : isOn ? t('on') : t('off');
      var pending = busy !== undefined && busy.split(':')[1] === component.id;
      var reading = pending ? busy.split(':')[0] : undefined;
      // A row of its own owns the switch: the host refuses an enable/disable from
      // this page in that shape, so drawing the button would draw a dead control.
      var ownSwitch = component.mode !== 'row';
      var title = spec === undefined ? component.id : spec.title;

      var buttons = [];
      if (isRemoved) {
        buttons.push(
          h(
            'button',
            {
              key: 'restore',
              type: 'button',
              style: primaryButtonStyle,
              disabled: pending,
              onClick: function () {
                store.act('restore', component.id);
              }
            },
            reading === 'restore' ? t('restoring') : t('restore')
          )
        );
      } else {
        if (ownSwitch) {
          buttons.push(
            h(
              'button',
              {
                key: 'toggle',
                type: 'button',
                style: isOn ? buttonStyle : primaryButtonStyle,
                disabled: pending,
                onClick: function () {
                  store.act(isOn ? 'disable' : 'enable', component.id);
                }
              },
              pending ? '…' : isOn ? t('disable') : t('enable')
            )
          );
        }
        if (isOn) {
          buttons.push(
            h(
              'button',
              {
                key: 'refresh',
                type: 'button',
                style: buttonStyle,
                disabled: pending,
                onClick: function () {
                  store.act('refresh', component.id);
                }
              },
              reading === 'refresh' ? t('refreshing') : t('refresh')
            )
          );
        }
        buttons.push(
          h(
            'button',
            {
              key: 'uninstall',
              type: 'button',
              style: buttonStyle,
              disabled: pending,
              onClick: function () {
                store.act('uninstall', component.id);
              }
            },
            t('uninstall')
          )
        );
      }

      // The line under the controls: who is signed in, on which build. Composed
      // from `located`, which is the driver's own words, never a guess.
      var located = component.located;
      var identity = [];
      if (spec !== undefined) identity.push(spec.vendor);
      if (typeof located === 'object' && located !== null) {
        if (typeof located.signedIn === 'boolean') identity.push(t(located.signedIn ? 'signedInLine' : 'signedOutLine'));
        if (typeof located.version === 'string' && located.version !== '') {
          identity.push(format(t('versionPrefix'), { version: located.version }));
        }
      }
      if (identity.length === 0) identity.push(t('noData'));

      var notices = [];
      if (isRemoved) {
        notices.push(h('div', { key: 'parked', style: noticeStyle }, h('span', null, t('parkedHint'))));
      } else if (!isOn) {
        notices.push(h('div', { key: 'off', style: noticeStyle }, h('span', null, t('offHint'))));
      } else if (!ownSwitch) {
        // The row's own switch is the control; say so once instead of leaving a
        // reader to wonder why this page has every button except the on/off one.
        // A note rather than a box: the box is for a state that hides the data,
        // and this one is a footnote beside data that is right there.
        notices.push(h('p', { key: 'switch', style: noteStyle }, t('switchInList')));
      }
      if (isFailed) {
        notices.push(h('p', { key: 'reason', style: errorStyle }, t('reasonLabel') + ': ' + component.reason));
      }
      if (typeof component.locateError === 'string') {
        notices.push(h('p', { key: 'loc', style: errorStyle }, t('reasonLabel') + ': ' + component.locateError));
      }
      var fetchedAt = component.catalog ? time(component.catalog.fetchedAtMs) : null;
      var catalogError = component.catalog && typeof component.catalog.error === 'string' ? component.catalog.error : undefined;

      var tabs = [
        ['status', 'tabStatus'],
        ['models', 'tabModels'],
        ['account', 'tabAccount']
      ];
      var panel = null;
      if (isOn) {
        if (tab === 'models') {
          panel = h(
            'div',
            { style: tabPanelStyle },
            h(ModelSection, { t: t, component: component }),
            fetchedAt === null ? null : h('p', { style: noteStyle }, format(t('lastRead'), { time: fetchedAt })),
            catalogError === undefined ? null : h('p', { style: errorStyle }, catalogError)
          );
        } else if (tab === 'account') {
          panel = h(
            'div',
            { style: tabPanelStyle },
            h(AccountSection, { t: t, component: component, spec: spec }),
            fetchedAt === null ? null : h('p', { style: noteStyle }, format(t('lastRead'), { time: fetchedAt }))
          );
        } else {
          // The overview answers "what can I use right now", so a vendor serving
          // nothing says why here instead of leaving a lone quota line and a
          // reader wondering whether the page broke.
          var emptyModels = !Array.isArray(component.models) || component.models.length === 0;
          panel = h(
            'div',
            { style: tabPanelStyle },
            h(QuotaSection, { t: t, component: component }),
            emptyModels ? h('p', { style: noteStyle }, t('modelsEmpty')) : null,
            fetchedAt === null ? null : h('p', { style: noteStyle }, format(t('lastRead'), { time: fetchedAt })),
            catalogError === undefined ? null : h('p', { style: errorStyle }, catalogError)
          );
        }
      }

      var body = [
        h(
          'div',
          { key: 'toolbar', style: toolbarStyle },
          // The dot is the state and the words beside it are the identity, so the
          // header above stays two lines of prose exactly like the vendor card this
          // is modelled on, and no line says "已开启" twice within forty pixels.
          h(
            'span',
            { style: statusLineStyle, role: 'status' },
            h('span', { 'aria-hidden': 'true', style: stateDotStyle(component) }),
            h(
              'span',
              { style: { overflowWrap: 'anywhere' } },
              identity.join(' · ')
            )
          ),
          h('span', { style: buttonRowStyle }, buttons)
        ),
        ...notices
      ];
      if (isOn) {
        body.push(
          h(
            'div',
            { key: 'tabs', role: 'tablist', style: tabBarStyle },
            tabs.map(function (pair) {
              return h(
                'button',
                {
                  key: pair[0],
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tab === pair[0],
                  style: tab === pair[0] ? { ...tabStyle, ...tabActiveStyle } : tabStyle,
                  onClick: function () {
                    setTab(pair[0]);
                  }
                },
                t(pair[1])
              );
            })
          ),
          h('div', { key: 'panel' }, panel)
        );
      }

      // The harness prints a row page's own title as an `<h3>` above this content,
      // and the crumb above that repeats it. So on a row page the card carries no
      // name of its own — the summary is the header, and the card reads as a panel
      // belonging to the title already on screen. A bundle page has no such title
      // for its three cards, so there the name is the header's first line.
      var showName = element !== 'div';

      return h(
        element === 'div' ? 'div' : 'li',
        { style: cardStyle },
        h(
          'button',
          {
            type: 'button',
            style: showName ? headerStyle : headerBarStyle,
            'aria-expanded': open,
            'aria-label': t(open ? 'collapse' : 'expand') + ': ' + title,
            onClick: function () {
              setOpen(!open);
            }
          },
          h(
            'span',
            { style: headTextStyle },
            showName ? h('span', { style: nameStyle }, title) : null,
            h(
              'span',
              { style: showName ? descriptionStyle : headerSummaryStyle },
              summary === undefined ? stateLabel : summary
            )
          ),
          h(
            'span',
            { 'aria-hidden': 'true', style: { ...chevronStyle, transform: open ? 'rotate(180deg)' : 'none' } },
            '\u2304'
          )
        ),
        open ? h('div', { style: cardBodyStyle }, body) : null
      );
    }

    /**
     * One vendor, read from that vendor's own route.
     *
     * `view: 'summary'` is the one line a row of the components list can show —
     * state, how many models, how much allowance — and it becomes that row's
     * description. `view: 'page'` is the row's own page: account facts, allowance
     * by package, every model, and whichever controls the shape allows.
     *
     * Each vendor subscribes to its own store, so one vendor's failed poll cannot
     * blank the other two.
     */
    function VendorView(props) {
      var store = props.store;
      var componentId = props.componentId;
      if (store === undefined) return null;
      var snapshot = react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      var component = componentFrom(snapshot, componentId);

      if (props.view === 'summary') return h('span', null, summaryLine(store, component));

      if (component === undefined) {
        if (snapshot.status !== 'failed') {
          return h('p', { style: noteStyle }, translateFor(store, 'loading'));
        }
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          h('p', { style: errorStyle }, translateFor(store, 'loadFailed') + ': ' + String(snapshot.error || '')),
          h(
            'div',
            null,
            h(
              'button',
              { type: 'button', style: primaryButtonStyle, onClick: function () { store.reload(); } },
              translateFor(store, 'retry')
            )
          )
        );
      }
      return h(VendorPanel, {
        t: function (key) {
          return translateFor(store, key);
        },
        component: component,
        spec: COMPONENTS[componentId],
        store: store,
        busy: snapshot.busy,
        summary: summaryLine(store, component),
        // A row's own page opens: opening it is the click that asked for it. The
        // bundle page passes `false`, so its three cards start collapsed and the
        // page reads as three summaries rather than three walls.
        defaultOpen: props.defaultOpen !== false,
        element: props.element === 'li' ? 'li' : 'div'
      });
    }

    /**
     * The page the Plugins screen renders for this bundle.
     *
     * The bundle page is the three vendors together, each read from its own route:
     * the bundle has no route of its own in the three-row shape, and inventing one
     * would put a fourth reader on the same three switches.
     *
     * `view === 'summary'` is the one-line form the Plugins list shows.
     */
    function AgentBridgePage(props) {
      var view = props.view;
      var stores = props.stores;
      var primary = stores[Object.keys(COMPONENTS)[0]];
      // The page's own copy is its own namespace, so it follows the browser's
      // language rather than the harness copy.
      react.useEffect(
        function () {
          var language =
            typeof navigator !== 'undefined' && typeof navigator.language === 'string'
              ? navigator.language.slice(0, 2).toLowerCase()
              : 'zh';
          Object.keys(stores).forEach(function (id) {
            stores[id].setLanguage(language);
          });
        },
        []
      );

      if (primary === undefined) return null;
      if (view === 'summary') return primary.t('intro');

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('p', { style: blurbStyle }, primary.t('intro')),
        h(
          'ul',
          { style: pageStyle },
          Object.keys(COMPONENTS).map(function (componentId) {
            return h(VendorView, {
              key: componentId,
              view: 'page',
              store: stores[componentId],
              componentId: componentId,
              element: 'li',
              defaultOpen: false
            });
          })
        ),
        h('p', { style: noteStyle }, primary.t('stateNote'))
      );
    }

    /* ---------------------------------------------------------- registration */

    /** Services this browser half waits for before it contributes anything. */
    var inject = ['slots', 'locale'];

    /**
     * Contribute the page, guarding every boundary that can throw.
     *
     * A slot entry that throws blanks its own entry and leaves a console line, so
     * each contribution is wrapped: a broken page must cost the page, not the
     * plugin, and never the rest of the harness UI.
     */
    function apply(ctx) {
      try {
        ctx.effect(
          function () {
            ctx.locale.register(NAMESPACE, { zh: zh, en: en });
          },
          'dsh-agent-bridge: page copy'
        );
      } catch {
        /* the page still renders with its built-in copy */
      }

      // One store per vendor, each on its own route. They poll independently: a
      // vendor whose route is gone because its row is switched off must not take
      // the other two panels down with it.
      var stores = {};
      try {
        Object.keys(COMPONENTS).forEach(function (componentId) {
          stores[componentId] = createStore(pathsFor(componentId));
        });
        ctx.effect(function () {
          var stops = Object.keys(stores).map(function (id) {
            return stores[id].start();
          });
          return function () {
            stops.forEach(function (stop) {
              stop();
            });
          };
        }, 'dsh-agent-bridge: status polling');
      } catch {
        return;
      }

      // The bundle page: the three vendors together, composed here rather than
      // read from an aggregate route, because the bundle has no route of its own
      // once each vendor is a row.
      try {
        ctx.slots.inject('plugins.bundle.config', function () {
          return (
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: 'dsh-agent-bridge',
                locale: NAMESPACE,
                inject: function () {
                  return { stores: stores };
                }
              },
              AgentBridgePage
            ) || function () {}
          );
        });
      } catch {
        /* a host without this slot shows the bundle without a page */
      }

      // Each vendor's own page, under the key DSH builds from the bundle name and
      // the row id in `cordis.patch.yml` (`<bundle>#<rowId>`). This is what puts a
      // chevron on each row of «包含的组件», and each one opens only its own vendor.
      // Registered one at a time with its own guard: a host that rejects one row's
      // page leaves the other rows' pages and the bundle page intact.
      Object.keys(COMPONENTS).forEach(function (componentId) {
        var rowId = ROW_PREFIX + componentId;
        try {
          ctx.slots.inject(ROW_SLOT, function () {
            return (
              ctx.slots.register(
                {
                  name: ROW_SLOT,
                  key: 'dsh-agent-bridge#' + rowId,
                  locale: NAMESPACE,
                  inject: function () {
                    return { store: stores[componentId], componentId: componentId };
                  }
                },
                VendorView
              ) || function () {}
            );
          });
        } catch {
          /* the row still has its switch; only its own page is missing */
        }
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = 'dsh-agent-bridge';
    return module.exports;
  }
});
