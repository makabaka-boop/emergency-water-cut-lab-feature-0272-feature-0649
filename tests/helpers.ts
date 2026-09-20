import { expect } from 'vitest'
import { compareCutItems } from '../src/core/analyze'
import { FlowEdge, maxFlow } from '../src/core/maxflow'
import { CutItem, Network } from '../src/core/types'

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 随机小网络：2..8 节点、0..14 条管段、1..3 个供水/需求点，
 * 容量 0..20（含零容量），天然覆盖重边、反向边、自环与多源多汇。
 */
export function randomNetwork(rng: () => number): Network {
  const nodeCount = 2 + Math.floor(rng() * 7)
  const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
  const pick = () => ids[Math.floor(rng() * nodeCount)]
  const arcCount = Math.floor(rng() * 15)
  const arcs = Array.from({ length: arcCount }, (_, i) => ({
    id: `a${i}`,
    from: pick(),
    to: pick(),
    capacity: Math.floor(rng() * 21),
  }))
  const shuffled = [...ids]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = t
  }
  const srcCount = 1 + Math.floor(rng() * Math.min(3, nodeCount))
  const snkCount = 1 + Math.floor(rng() * Math.min(3, nodeCount))
  const sources = shuffled
    .slice(0, srcCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 21) }))
  const sinks = shuffled
    .slice(nodeCount - snkCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 21) }))
  return { nodes: ids.map((id) => ({ id })), arcs, sources, sinks }
}

export function randomDisabled(net: Network, rng: () => number): Set<string> {
  const s = new Set<string>()
  net.arcs.forEach((a) => {
    if (rng() < 0.3) s.add(a.id)
  })
  return s
}

/**
 * 10000 节点 / 50000 管段的层状网络（与 maxflow.test.ts 同一确定性构造，
 * 抽到 helpers 以便性能用例复用）：99×100×5 条层间前向边 + 250 条反向边
 * + 250 条重边，首末层各 100 个供水/需求点。
 */
export function buildLargeNetwork(): Network {
  const rng = mulberry32(42)
  const LAYERS = 100
  const PER = 100
  const nodes: { id: string }[] = []
  for (let l = 0; l < LAYERS; l++) {
    for (let i = 0; i < PER; i++) nodes.push({ id: `L${l}N${i}` })
  }
  const arcs: Network['arcs'] = []
  let counter = 0
  const randCap = () => Math.floor(rng() * 1_000_000_000)
  for (let l = 0; l < LAYERS - 1; l++) {
    for (let i = 0; i < PER; i++) {
      for (let k = 0; k < 5; k++) {
        const j = Math.floor(rng() * PER)
        arcs.push({
          id: `a${counter++}`,
          from: `L${l}N${i}`,
          to: `L${l + 1}N${j}`,
          capacity: randCap(),
        })
      }
    }
  }
  for (let i = 0; i < 250; i++) {
    const l = Math.floor(rng() * (LAYERS - 1))
    arcs.push({
      id: `a${counter++}`,
      from: `L${l + 1}N${Math.floor(rng() * PER)}`,
      to: `L${l}N${Math.floor(rng() * PER)}`,
      capacity: randCap(),
    })
  }
  for (let i = 0; i < 250; i++) {
    const l = Math.floor(rng() * (LAYERS - 1))
    const u = Math.floor(rng() * PER)
    arcs.push({
      id: `a${counter++}`,
      from: `L${l}N${u}`,
      to: `L${l + 1}N${u}`,
      capacity: randCap(),
    })
  }
  const sources: Network['sources'] = []
  const sinks: Network['sinks'] = []
  for (let i = 0; i < PER; i++) {
    sources.push({ node: `L0N${i}`, capacity: 1_000_000_000 })
    sinks.push({ node: `L${LAYERS - 1}N${i}`, capacity: 1_000_000_000 })
  }
  return { nodes, arcs, sources, sinks }
}

/**
 * 穷举所有源侧/汇侧二分，直接求最小割容量（与任何最大流实现无关）。
 * 仅适用于节点数 ≤ 12 的小图。
 */
export function bruteForceMinCut(
  net: Network,
  disabled: ReadonlySet<string>,
): number {
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const n = net.nodes.length
  let best = Infinity
  for (let mask = 0; mask < 1 << n; mask++) {
    const inS = (id: string) => ((mask >> idx.get(id)!) & 1) === 1
    let cap = 0
    for (const s of net.sources) if (!inS(s.node)) cap += s.capacity
    for (const k of net.sinks) if (inS(k.node)) cap += k.capacity
    for (const a of net.arcs) {
      if (disabled.has(a.id)) continue
      if (inS(a.from) && !inS(a.to)) cap += a.capacity
    }
    if (cap < best) best = cap
  }
  return best
}

export interface IndependentResult {
  value: number
  cut: CutItem[]
}

/**
 * 独立复核：
 *  1. 按契约建模并调用 maxFlow；
 *  2. 校验所得流量的可行性（容量约束、节点守恒、源汇平衡）；
 *  3. 由流量（而非 maxFlow 内部状态）重建残量网络，遍历得到割项。
 */
export function independentSolve(
  net: Network,
  disabled: ReadonlySet<string>,
): IndependentResult {
  const n = net.nodes.length
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const S = n
  const T = n + 1
  const edges: FlowEdge[] = []
  const arcEdgeIdx: number[] = []
  net.arcs.forEach((a) => {
    if (disabled.has(a.id)) {
      arcEdgeIdx.push(-1)
    } else {
      arcEdgeIdx.push(edges.length)
      edges.push({
        from: idx.get(a.from)!,
        to: idx.get(a.to)!,
        capacity: a.capacity,
      })
    }
  })
  net.sources.forEach((s) => {
    edges.push({ from: S, to: idx.get(s.node)!, capacity: s.capacity })
  })
  net.sinks.forEach((k) => {
    edges.push({ from: idx.get(k.node)!, to: T, capacity: k.capacity })
  })

  const res = maxFlow(n + 2, edges, S, T)

  // 流量可行性校验。
  const balance = new Float64Array(n + 2)
  edges.forEach((e, i) => {
    const f = res.flow[i]
    expect(Number.isSafeInteger(f)).toBe(true)
    expect(f).toBeGreaterThanOrEqual(0)
    expect(f).toBeLessThanOrEqual(e.capacity)
    balance[e.from] -= f
    balance[e.to] += f
  })
  for (let v = 0; v < n; v++) expect(balance[v]).toBe(0)
  expect(balance[S]).toBe(0 - res.value)
  expect(balance[T]).toBe(res.value)

  // 由流量独立重建残量网络并求源侧可达集。
  const adj: number[][] = Array.from({ length: n + 2 }, () => [])
  edges.forEach((e, i) => {
    const f = res.flow[i]
    if (e.capacity - f > 0) adj[e.from].push(e.to)
    if (f > 0) adj[e.to].push(e.from)
  })
  const reach = new Array<boolean>(n + 2).fill(false)
  const stack = [S]
  reach[S] = true
  while (stack.length > 0) {
    const v = stack.pop()!
    for (const w of adj[v]) {
      if (!reach[w]) {
        reach[w] = true
        stack.push(w)
      }
    }
  }

  const cut: CutItem[] = []
  net.sources.forEach((s) => {
    if (!reach[idx.get(s.node)!]) {
      cut.push({ kind: 'source', id: s.node, capacity: s.capacity })
    }
  })
  net.arcs.forEach((a, i) => {
    if (arcEdgeIdx[i] === -1) return
    if (reach[idx.get(a.from)!] && !reach[idx.get(a.to)!]) {
      cut.push({
        kind: 'arc',
        id: a.id,
        from: a.from,
        to: a.to,
        capacity: a.capacity,
      })
    }
  })
  net.sinks.forEach((k) => {
    if (reach[idx.get(k.node)!]) {
      cut.push({ kind: 'sink', id: k.node, capacity: k.capacity })
    }
  })
  cut.sort(compareCutItems)
  return { value: res.value, cut }
}
