/**
 * Browser half: the Settings → Plugins card for this plugin's trim namespace.
 *
 * The Plugins tab pairs every settings namespace the Host serves with a card
 * registered under the SAME key (a KEYED slot: `key: <namespace>`, dispatched
 * with `entryKey`), so a host namespace without a card renders nothing. The tab
 * lays out one flex column and nothing else — the host's contract is that "a
 * plugin that ships a browser half owns its own card: chrome, controls, and
 * copy" — so the collapsible header, chevron, footer, and spacing below mirror
 * the host's `PluginCard`, using the host's own rules and `--dsw-alias-*` tokens.
 * Two deliberate deviations: the unsaved badge is hand-drawn rather than the
 * host's `Tag` primitive (that would need a non-baseline module request), and the
 * failure line uses `--dsw-alias-state-error-primary` because the host's own
 * `--dsw-alias-label-error` is not defined in the installed theme.
 *
 * Hand-written rather than bundled: the loader envelope is the whole contract,
 * `react` is a baseline platform module, and the repository deliberately stays
 * build-step free — `node --check` still lints it.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-subagent-roles',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')

    /** Settings namespace + slot key of the default row (see lib/settings.js). */
    const NAMESPACE = 'subagent-roles'
    /** The trim postures the Host accepts, labelled through the locale seat. */
    const MODES = [
      { value: 'full', key: 'modeFull' },
      { value: 'tools', key: 'modeTools' },
      { value: 'off', key: 'modeOff' },
    ]
    /** The tool-call budget postures. */
    const BUDGET_MODES = [
      { value: 'wrap-up', key: 'budgetWrapup' },
      { value: 'interrupt', key: 'budgetInterrupt' },
      { value: 'off', key: 'budgetOff' },
    ]
    /**
     * Every settings key this card edits, in render order.
     *
     * Declared as DATA because the card must cover the WHOLE namespace: a key the
     * Host serves but this list forgets would be invisible in the UI while
     * `settings.yaml` still honoured it. `test/client.test.js` pins this list
     * against the settings schema exactly so that cannot happen silently.
     *
     * `kind` decides the control and the value conversion — `select` keeps a
     * string, `list` maps text to a string array, `count` maps text to a
     * non-negative integer (the Host stores a number, not a digit string).
     * `fallback` answers for a missing or unusable value; the row config always
     * supplies one through the `base` layer, so it is a last resort.
     */
    const FIELDS = [
      { settingsKey: 'childPromptTrim', kind: 'select', options: MODES, fallback: 'full', label: 'mode', hint: 'modeHint' },
      { settingsKey: 'childPromptTrimNames', kind: 'list', fallback: [], label: 'names', hint: 'namesHint' },
      { settingsKey: 'defaultMaxToolCalls', kind: 'count', fallback: 0, label: 'maxToolCalls', hint: 'maxToolCallsHint' },
      { settingsKey: 'maxToolCallsHardCap', kind: 'count', fallback: 0, label: 'hardCap', hint: 'hardCapHint' },
      { settingsKey: 'onToolCallBudget', kind: 'select', options: BUDGET_MODES, fallback: 'wrap-up', label: 'budgetMode', hint: 'budgetModeHint' },
      { settingsKey: 'graceToolCalls', kind: 'count', fallback: 1, label: 'grace', hint: 'graceHint' },
    ]
    /** The field keys the card writes through, derived so the two cannot drift. */
    const FIELD_KEYS = FIELDS.map((field) => field.settingsKey)

    /**
     * Card copy, registered as this plugin's locale dictionaries so the card
     * follows the Language setting like every other DSH surface. `en` doubles as
     * the fallback for a deployment with no locale service.
     */
    const COPY = {
      en: {
        title: 'Subagent roles',
        description: 'Child prompt trim and the tool-call budget — subagent sessions only; the main agent prompt is never touched.',
        mode: 'Mode',
        modeFull: 'full — tool, surface and harness sections',
        modeTools: 'tools — tool guidance only',
        modeOff: 'off — disable the trim',
        modeHint: 'Applies to the next child turn. "tools" keeps the Web GUI, harness-checkout, deliverable, and @-path parts.',
        names: 'Dropped prompt parts',
        namesHint: 'Comma-separated names, matched against sections and contexts. Empty keeps every part.',
        maxToolCalls: 'Default tool-call budget',
        maxToolCallsHint: 'Used when a role file declares no maxToolCalls. 0 means unlimited; a role file always wins.',
        hardCap: 'Tool-call hard cap',
        hardCapHint: 'Ceiling a role file cannot exceed. 0 disables the ceiling, and never clamps an "unlimited" 0.',
        budgetMode: 'On budget exhaustion',
        budgetWrapup: 'wrap-up — inject a notice, then allow the grace calls',
        budgetInterrupt: 'interrupt — stop the child immediately',
        budgetOff: 'off — warn only, never stop',
        budgetModeHint: 'Counted in tool CALLS, not turns: parallel calls in one step each count.',
        grace: 'Grace calls',
        graceHint: 'Extra calls wrap-up tolerates after its notice. 0 stops on the crossing call itself.',
        overridden: 'overridden',
        unsaved: 'unsaved',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        reset: 'Reset all to deployment defaults',
        resetField: 'Reset',
        saved: 'saved',
        saveFailed: 'save failed',
        unavailable: 'settings are not served by this deployment',
        expand: 'expand',
        collapse: 'collapse',
      },
      zh: {
        title: '子代理角色',
        description: '子代理提示词裁剪与工具调用预算——只作用于子代理会话，主代理提示词永不改动。',
        mode: '模式',
        modeFull: 'full — 工具、界面与 harness 段落一并裁剪',
        modeTools: 'tools — 只裁剪工具说明',
        modeOff: 'off — 关闭裁剪',
        modeHint: '下一个子代理轮次即生效。"tools" 会保留 Web GUI、harness checkout、交付链接与 @路径 这几段。',
        names: '丢弃的提示词片段',
        namesHint: '逗号分隔的名字，section 与 context 一并匹配；清空即全部保留。',
        maxToolCalls: '默认工具调用额度',
        maxToolCallsHint: '角色文件未声明 maxToolCalls 时使用；0 表示不限。角色文件永远优先。',
        hardCap: '工具调用硬上限',
        hardCapHint: '角色文件不得超过的上限；0 表示不设上限，且永不削顶「不限」的 0。',
        budgetMode: '额度耗尽时',
        budgetWrapup: 'wrap-up — 先注入收尾通知，再放行 grace 次调用',
        budgetInterrupt: 'interrupt — 立即中断子代理',
        budgetOff: 'off — 只告警，不拦截',
        budgetModeHint: '计量单位是「次」而非「轮」：同一步内并行调用分别计 1。',
        grace: '宽限调用次数',
        graceHint: 'wrap-up 注入通知后额外放行的调用次数；0 表示在触发的那一次调用上直接收口。',
        overridden: '已覆盖',
        unsaved: '未保存',
        save: '保存',
        saving: '保存中…',
        discard: '放弃',
        reset: '全部重置为部署默认',
        resetField: '重置',
        saved: '已保存',
        saveFailed: '保存失败',
        unavailable: '本部署未提供设置服务',
        expand: '展开',
        collapse: '收起',
      },
    }

    /** English fallback for a deployment that serves no locale service. */
    const FALLBACK_T = (key) => COPY.en[key] ?? key

    /**
     * Card chrome. Every declaration below is copied from the host's own
     * `PluginCard.module.css` — same rules, same `--dsw-alias-*` tokens — with a
     * plugin-scoped class prefix, because a client bundle may not import host
     * values (bundle purity) but must not invent its own palette either. An
     * earlier revision invented a `label-inverse` alias for the Save button;
     * no such token exists, so the colour fell back to white over a light
     * background and the label became invisible.
     */
    const CSS = [
      '.dsr-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}',
      '.dsr-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dsr-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsr-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.dsr-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dsr-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.dsr-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.dsr-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.dsr-pending{flex:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 8px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dsr-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      '.dsr-chevronOpen{transform:rotate(180deg)}',
      '.dsr-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.dsr-field{display:flex;flex-direction:column;gap:5px;padding-top:12px}',
      '.dsr-labelRow{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dsr-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.dsr-link{appearance:none;font:inherit;font-size:12px;line-height:1.5;cursor:pointer;border:0;background:0 0;padding:0;color:var(--dsw-alias-link)}',
      '.dsr-link:disabled{opacity:.4;cursor:default}',
      '.dsr-overridden{color:var(--dsw-alias-label-tertiary)}',
      '.dsr-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.dsr-input,.dsr-select{appearance:none;width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 10px}',
      '.dsr-input:focus-visible,.dsr-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsr-input:disabled,.dsr-select:disabled{opacity:.4;cursor:default}',
      '.dsr-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.dsr-reset{margin-right:auto}',
      '.dsr-button,.dsr-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.dsr-button{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.dsr-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.dsr-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.dsr-button:disabled,.dsr-save:disabled{opacity:.4;cursor:default}',
      '.dsr-button:focus-visible,.dsr-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dsr-status{min-width:0;flex:1;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.dsr-statusFailed{color:var(--dsw-alias-state-error-primary)}',
    ].join('')

    /** Install the stylesheet once per page, like the host's own client plugins do. */
    function installStyles() {
      const tagId = 'dsh-plugin-subagent-roles/card.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-subagent-roles'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Comma-joined text for the name-list field. */
    function toText(value) {
      return Array.isArray(value) ? value.join(', ') : ''
    }

    /** Split a staged list field back into the array the Host stores. */
    function toList(text) {
      return String(text ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    }

    /** The control text for one resolved settings value. */
    function fieldText(field, value) {
      if (field.kind === 'list') return toText(value ?? field.fallback)
      if (field.kind === 'count') return String(Number.isSafeInteger(value) ? value : field.fallback)
      return typeof value === 'string' ? value : field.fallback
    }

    /**
     * The settings value one staged text stands for.
     *
     * A count is parsed strictly: the Host stores `z.natural()`, so "8.5", "-1",
     * and "" must not become a number it would refuse. Unusable text folds to the
     * field's fallback, which keeps Save from ever writing an invalid count.
     */
    function fieldValue(field, text) {
      if (field.kind === 'list') return toList(text)
      if (field.kind === 'count') {
        const trimmed = String(text ?? '').trim()
        if (!/^\d+$/.test(trimmed)) return field.fallback
        const parsed = Number.parseInt(trimmed, 10)
        return Number.isSafeInteger(parsed) ? parsed : field.fallback
      }
      return text
    }

    /** Whether two staged texts describe the same settings value. */
    function sameFieldValue(field, left, right) {
      if (field.kind === 'list') return sameNames(left, right)
      if (field.kind === 'count') return fieldValue(field, left) === fieldValue(field, right)
      return left === right
    }

    /**
     * The writes one Save performs.
     *
     * A staged field is CLEARED, not written: clearing re-inherits the
     * composition layer, while writing today's default would pin it as an
     * override the deployment can no longer retune. A field whose staged text
     * still equals the resolved value is NOT written at all — presence in the
     * user layer is what marks a field overridden, so writing it would shadow a
     * later deployment change to a field the user never touched. Pure, so the
     * semantics are unit-testable without a DOM.
     */
    function planSave(staged, shown, current) {
      const steps = []
      for (const field of FIELDS) {
        if (staged.includes(field.settingsKey)) {
          steps.push({ kind: 'unset', field: field.settingsKey })
          continue
        }
        if (sameFieldValue(field, shown[field.settingsKey], current[field.settingsKey])) continue
        steps.push({ kind: 'set', field: field.settingsKey, value: fieldValue(field, shown[field.settingsKey]) })
      }
      return steps
    }

    /**
     * Apply one edit to the staged state.
     *
     * Editing a field also CANCELS a reset staged for it: what the user typed is
     * what Save must write, and keeping the field staged would silently throw
     * that edit away in favour of a clear.
     * @param state - the current `draft` (or undefined), `shown`, and `staged`.
     * @param field - the field being edited.
     * @param next - the partial value to merge into the draft.
     * @returns the next draft and staged list.
     */
    function applyEdit(state, field, next) {
      return {
        draft: { ...(state.draft ?? state.shown), ...next },
        staged: state.staged.filter((entry) => entry !== field),
      }
    }

    /** Subscribe a component to one settings namespace snapshot. */
    function useSettings(scope) {
      const subscribe = React.useCallback((onChange) => scope.subscribe(onChange), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * One staged field: label row (with an inline reset), control, hint.
     *
     * The control is rendered by the caller with the id this component mints, so
     * the `<label htmlFor>` association is real rather than implied by nesting.
     */
    function Field(props) {
      const id = React.useId()
      const resettable = props.onReset !== undefined
      return React.createElement(
        'div',
        { className: 'dsr-field' },
        React.createElement(
          'span',
          { className: 'dsr-labelRow' },
          React.createElement(
            'label',
            { className: 'dsr-label', htmlFor: id },
            props.label,
            props.overridden
              ? React.createElement('span', { className: 'dsr-overridden' }, ` · ${props.t('overridden')}`)
              : null,
          ),
          resettable
            ? React.createElement(
              'button',
              {
                type: 'button',
                className: 'dsr-link',
                disabled: props.disabled === true,
                onClick: props.onReset,
              },
              props.t('resetField'),
            )
            : null,
        ),
        props.renderControl(id),
        props.hint === undefined ? null : React.createElement('span', { className: 'dsr-hint' }, props.hint),
      )
    }

    /** A 14px chevron that rotates with the card, matching the host's icon. */
    function Chevron(props) {
      return React.createElement(
        'svg',
        {
          className: `dsr-chevron${props.open ? ' dsr-chevronOpen' : ''}`,
          width: 14,
          height: 14,
          viewBox: '0 0 14 14',
          'aria-hidden': 'true',
        },
        React.createElement('path', {
          d: 'M3.5 5.25 7 8.75l3.5-3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Whether two staged lists describe the same names, in the same order. */
    function sameNames(left, right) {
      const a = toList(left)
      const b = toList(right)
      return a.length === b.length && a.every((entry, index) => entry === b[index])
    }

    /**
     * The card: host-shaped collapsible chrome over a staged form.
     *
     * Follows the host's editing conventions: every control renders staged text,
     * nothing is written before Save, Discard drops the drafts, a reset STAGES
     * the composed default (it does not write, and it does not silently discard
     * the other field's draft), a clean save collapses the card, and a failed
     * save keeps the drafts open for correction.
     */
    function TrimSettingsCard(props) {
      const scope = props.scope
      // The renderer binds `t` to the locale namespace this card declares; the
      // plugin's own binding (or its English dictionary) answers otherwise.
      const t = typeof props.t === 'function' ? props.t : props.fallbackT ?? FALLBACK_T
      const snapshot = useSettings(scope)
      const value = snapshot.value ?? {}
      const user = snapshot.user ?? {}
      const base = snapshot.base ?? {}
      const writable = snapshot.writable === true
      const [open, setOpen] = React.useState(false)
      // `undefined` means "not editing yet": the draft then follows the Host.
      const [draft, setDraft] = React.useState(undefined)
      // Fields staged for a reset: Save CLEARS them so they re-inherit.
      const [staged, setStaged] = React.useState(() => [])
      const [status, setStatus] = React.useState('idle')
      const [errorText, setErrorText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const savingRef = React.useRef(false)

      // Every field renders staged TEXT; the settings value is derived on save.
      // `base` is the deployment's row config (the namespace's base layer), so a
      // reset stages the DEPLOYMENT default rather than today's resolved value.
      const baseText = {}
      const currentText = {}
      for (const field of FIELDS) {
        baseText[field.settingsKey] = fieldText(field, base[field.settingsKey])
        currentText[field.settingsKey] = fieldText(field, value[field.settingsKey] ?? base[field.settingsKey])
      }
      const shown = draft ?? currentText
      const overridden = (field) => Object.hasOwn(user, field)
      const dirty = staged.length > 0 || (draft !== undefined
        && FIELDS.some((field) => !sameFieldValue(field, shown[field.settingsKey], currentText[field.settingsKey])))
      const patch = (field, next) => {
        const edited = applyEdit({ draft, shown, staged }, field, next)
        setDraft(edited.draft)
        setStaged(edited.staged)
      }
      const stageReset = (field, text) => {
        setStaged((previous) => (previous.includes(field) ? previous : [...previous, field]))
        setDraft({ ...shown, [field]: text })
      }

      // The host collapses a card once its save settles clean.
      React.useEffect(() => {
        if (busy || status !== 'saved') return
        setOpen(false)
      }, [busy, status])

      const resetDrafts = () => {
        setDraft(undefined)
        setStaged([])
        setStatus('idle')
        setErrorText('')
      }

      const write = (operations) => {
        // `busy` is state and lands a render later, so a fast double-click could
        // start two write sequences; the ref closes that window.
        if (savingRef.current) return
        savingRef.current = true
        setBusy(true)
        setStatus('idle')
        setErrorText('')
        Promise.resolve()
          .then(operations)
          .then(() => {
            // The namespace snapshot is authoritative again once the write
            // lands; keeping the drafts would leave the card marked unsaved.
            setDraft(undefined)
            setStaged([])
            setStatus('saved')
          })
          .catch((error) => {
            setErrorText(String(error?.message ?? error))
            setStatus('failed')
          })
          .finally(() => {
            savingRef.current = false
            setBusy(false)
          })
      }

      const save = () => write(async () => {
        for (const step of planSave(staged, shown, currentText)) {
          if (step.kind === 'unset') await scope.unset(step.field)
          else await scope.set(step.field, step.value)
        }
      })

      /** The control one field's `kind` calls for. */
      const renderControl = (field, id) => {
        if (field.kind === 'select') {
          return React.createElement(
            'select',
            {
              id,
              className: 'dsr-select',
              disabled: !writable || busy,
              value: shown[field.settingsKey],
              onChange: (event) => patch(field.settingsKey, { [field.settingsKey]: event.target.value }),
            },
            ...field.options.map((option) => React.createElement('option', { key: option.value, value: option.value }, t(option.key))),
          )
        }
        return React.createElement('input', {
          id,
          className: 'dsr-input',
          disabled: !writable || busy,
          ...(field.kind === 'count' ? { inputMode: 'numeric' } : {}),
          value: shown[field.settingsKey],
          onChange: (event) => patch(field.settingsKey, { [field.settingsKey]: event.target.value }),
        })
      }

      const title = t('title')
      const blocked = !writable || busy || !dirty

      return React.createElement(
        'li',
        { className: `dsr-card${open ? ' dsr-cardOpen' : ''}` },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsr-header',
            'aria-expanded': open,
            'aria-label': `${t(open ? 'collapse' : 'expand')}: ${title}`,
            onClick: () => {
              // A fresh look at an expanded card should not show the previous
              // save's confirmation.
              if (!open) setStatus('idle')
              setOpen(!open)
            },
          },
          React.createElement(
            'span',
            { className: 'dsr-headText' },
            React.createElement('span', { className: 'dsr-name' }, title),
            React.createElement('span', { className: 'dsr-description' }, t('description')),
          ),
          dirty ? React.createElement('span', { className: 'dsr-pending' }, t('unsaved')) : null,
          React.createElement(Chevron, { open }),
        ),
        !open
          ? null
          : React.createElement(
            'div',
            { className: 'dsr-body' },
            ...FIELDS.map((field) => React.createElement(Field, {
              key: field.settingsKey,
              t,
              label: t(field.label),
              overridden: overridden(field.settingsKey),
              disabled: !writable || busy,
              hint: t(field.hint),
              ...(overridden(field.settingsKey) || staged.includes(field.settingsKey)
                ? { onReset: () => stageReset(field.settingsKey, baseText[field.settingsKey]) }
                : {}),
              renderControl: (id) => renderControl(field, id),
            })),
            React.createElement(
              'div',
              { className: 'dsr-footer' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsr-button dsr-reset',
                  disabled: !writable || busy,
                  onClick: () => {
                    setStaged([...FIELD_KEYS])
                    setDraft({ ...baseText })
                  },
                },
                t('reset'),
              ),
              status === 'saved'
                ? React.createElement('p', { className: 'dsr-status', role: 'status' }, t('saved'))
                : null,
              status === 'failed'
                ? React.createElement('p', { className: 'dsr-status dsr-statusFailed', role: 'status' }, `${t('saveFailed')}: ${errorText}`)
                : null,
              // Reachable even for a dispatched namespace: a connection that keeps
              // preferences process-local reports `unavailable`.
              snapshot.status === 'unavailable'
                ? React.createElement('p', { className: 'dsr-status', role: 'status' }, t('unavailable'))
                : null,
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsr-button',
                  disabled: !dirty || busy,
                  onClick: resetDrafts,
                },
                t('discard'),
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dsr-button dsr-save',
                  disabled: blocked,
                  onClick: save,
                },
                busy ? t('saving') : t('save'),
              ),
            ),
          ),
      )
    }

    /**
     * Whether this page already applied the plugin.
     *
     * A duplicated client injection (the module factory executing twice in one
     * page lifetime) would otherwise register the card twice under the same
     * namespace key. The claim is released when the fiber unloads, so a rebuilt
     * bundle can claim the page again.
     */
    let claimed = false

    /**
     * Register the card under the key the Plugins tab dispatches.
     *
     * `settings.plugin.item` is a KEYED slot: the tab renders it once per served
     * namespace with `entryKey: ns`, and cards claim a namespace with `key`. An
     * `id` (the LIST-slot field) silently renders nothing.
     * @param ctx - client root context (services: slots, settingsScope).
     */
    function apply(ctx) {
      if (claimed) return
      claimed = true
      ctx.effect(() => () => {
        claimed = false
      }, 'subagent-roles: apply claim')
      installStyles()
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      // The card follows the Language setting: register this plugin's
      // dictionaries, declare the locale namespace so the renderer binds `t`,
      // and keep our own binding as the fallback prop.
      let localeField = {}
      let fallbackT = FALLBACK_T
      try {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NAMESPACE, COPY), 'subagent-roles: card copy')
          localeField = { locale: NAMESPACE }
          if (typeof locale.bind === 'function') fallbackT = locale.bind(NAMESPACE)
        }
      } catch {
        // No locale service: the English dictionary answers.
      }
      ctx.slots.inject('settings.plugin.item', () => {
        try {
          const unregister = ctx.slots.register({
            name: 'settings.plugin.item',
            key: NAMESPACE,
            ...localeField,
            inject: () => ({ scope, fallbackT }),
          }, TrimSettingsCard)
          return () => unregister()
        } catch (error) {
          // A deployment without the settings extension point keeps the Host
          // side only; the card must never break the browser boot.
          console.warn(`[subagent-roles] settings card not registered: ${String(error?.message ?? error)}`)
          return () => {}
        }
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    /**
     * Pure pieces, exposed for this package's Node smoke test only. The browser
     * loader reads `apply`/`inject` and ignores everything else, and no DOM is
     * needed to pin these.
     */
    exports.__internals = {
      planSave, applyEdit, sameNames, toList, toText, COPY, CSS,
      NAMESPACE, FIELDS, FIELD_KEYS, fieldText, fieldValue, sameFieldValue,
    }
    return module.exports
  },
})
