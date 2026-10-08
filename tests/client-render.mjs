import { readFileSync } from 'node:fs'
const calls = []
let state = { status: 'ready', value: { monitor: { enabled: true }, policy: { watchRatio: 0.45 }, autoHandoff: { enabled: false, atLevel: 'critical' } }, writable: true, mode: 'host', revision: 3 }
const react = {
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useId: () => 'id',
  useRef: () => ({ current: undefined }),
  useSyncExternalStore: (sub, get) => get(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: 'Fragment',
}
// Faithful stand-in: react/jsx-runtime takes children INSIDE props and has no
// third argument. A stub with a third argument would hide a real rendering bug.
const jsxRuntime = {
  jsx: (type, props, key) => ({ type, props, key }),
  jsxs: (type, props, key) => ({ type, props, key }),
  Fragment: 'Fragment',
}
const modules = new Map()
globalThis.window = { __ModuleLoader__: { load: (spec) => modules.set(spec.id, spec.factory((n) => n === 'react' ? react : jsxRuntime)) } }
new Function('window', readFileSync('D:/WishProject/dsh-session-handoff/lib/client.js', 'utf8'))(globalThis.window)
const mod = modules.get('dsh-session-handoff')

let registered
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  locale: { bind: () => (k) => k, register: () => () => {} },
  slots: { inject: (n, fn) => fn(), register: (o, c) => { registered = { options: o, component: c }; return () => {} } },
  configForms: {
    get: (ns) => {
      calls.push('get:' + ns)
      return {
        getSnapshot: () => state,
        subscribe: () => () => {},
        mutate: async (ops) => { calls.push('mutate:' + JSON.stringify(ops)); return true },
      }
    },
  },
  get: () => undefined,
}
mod.apply(ctx)
console.log('all configForms calls: ' + JSON.stringify(calls))
// Render the registered component the way the shell would.
const props = registered.options.inject()
const tree = registered.component({ t: (k) => k, ...props })
console.log('rendered root type: ' + tree.type)
console.log('child count: ' + (tree.props.children ?? []).length)
const texts = []
const walk = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node.props?.children === 'string') texts.push(node.props.children)
  walk(node.props?.children)
}
walk(tree)
console.log('labels rendered (' + texts.length + '): ' + JSON.stringify(texts.slice(0, 14)))
console.log('has the auto-handoff toggle label: ' + texts.includes('autoEnabled'))
console.log('has the compaction hint: ' + texts.includes('compactionHint'))

// Find the auto-handoff toggle element and drive its onChange.
const toggles = []
const collect = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(collect); return }
  if (node.type && node.type.name === 'ToggleField') toggles.push(node)
  collect(node.props?.children)
}
collect(tree)
console.log('toggle fields found: ' + toggles.length)
if (toggles.length > 0) {
  const target = toggles[toggles.length - 1]
  target.props.onCommit(true)
  await new Promise((r) => setTimeout(r, 10))
  console.log('after toggling the last switch, calls: ' + JSON.stringify(calls.filter(c => c.startsWith('mutate:'))))
}
