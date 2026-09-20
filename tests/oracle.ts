import { Network } from '../src/core/types'

/**
 * 枚举小整数网络的全部可行流（穷举预言机，与任何最大流实现无关）。
 *
 * 做法：枚举每条在用管段的整数流量（0..capacity，自环/重边/反向边各自独立），
 * 再由节点守恒逐节点解析供水边/需求边流量是否落在各自容量内；
 * 同一节点兼作供水点与需求点时，其需求流量在守恒允许的整数区间内逐一枚举。
 * 返回所有可行点（按 network.sinks 顺序的各需求边流量 + 总供水量）。
 *
 * 仅适用于 ≤4 节点、≤5 管段、容量 0..3 的小网络（枚举上界 4^5 × 5^2）。
 */
export interface FeasiblePoint {
  sinkY: number[]
  total: number
}

export function enumerateFeasibleFlows(
  net: Network,
  disabled: ReadonlySet<string>,
): FeasiblePoint[] {
  const n = net.nodes.length
  const idx = new Map(net.nodes.map((nd, i) => [nd.id, i]))
  const arcs = net.arcs
    .filter((a) => !disabled.has(a.id))
    .map((a) => ({ from: idx.get(a.from)!, to: idx.get(a.to)!, cap: a.capacity }))
  const sourceCap = new Int32Array(n)
  const sinkCap = new Int32Array(n)
  net.sources.forEach((s) => {
    sourceCap[idx.get(s.node)!] = s.capacity
  })
  net.sinks.forEach((k) => {
    sinkCap[idx.get(k.node)!] = k.capacity
  })
  const sourceNodes = new Set(net.sources.map((s) => idx.get(s.node)!))
  const sinkNodes = new Set(net.sinks.map((k) => idx.get(k.node)!))

  const points: FeasiblePoint[] = []
  const flows = new Int32Array(arcs.length)

  // 既是供水点又是需求点的节点：B=管段净入流，a(供水)-b(需求)=-B，
  // b=a+B，枚举 a∈[0,sc] 且 b∈[0,kc] 的所有整数 b。
  const bothChoicesAt = (B: number, v: number): number[] => {
    const sc = sourceCap[v]
    const kc = sinkCap[v]
    const bLo = Math.max(0, B)
    const bHi = Math.min(kc, sc + B)
    const out: number[] = []
    for (let b = bLo; b <= bHi; b++) out.push(b)
    return out
  }

  const leaf = () => {
    const B = new Int32Array(n) // 管段净入流
    arcs.forEach((a, i) => {
      B[a.to] += flows[i]
      B[a.from] -= flows[i]
    })

    let feasible = true
    const sinkB = new Int32Array(n) // 各节点最终需求流量
    const bothNodes: number[] = []
    const bothChoices: number[][] = []
    for (let v = 0; v < n; v++) {
      const asSource = sourceNodes.has(v)
      const asSink = sinkNodes.has(v)
      if (!asSource && !asSink) {
        if (B[v] !== 0) {
          feasible = false
          break
        }
      } else if (asSource && !asSink) {
        const a = -B[v]
        if (a < 0 || a > sourceCap[v]) {
          feasible = false
          break
        }
      } else if (!asSource && asSink) {
        const b = B[v]
        if (b < 0 || b > sinkCap[v]) {
          feasible = false
          break
        }
        sinkB[v] = b
      } else {
        const choices = bothChoicesAt(B[v], v)
        if (choices.length === 0) {
          feasible = false
          break
        }
        bothNodes.push(v)
        bothChoices.push(choices)
      }
    }
    if (!feasible) return

    const emit = () => {
      const sinkY = net.sinks.map((k) => sinkB[idx.get(k.node)!])
      const total = sinkY.reduce((s, y) => s + y, 0)
      points.push({ sinkY, total })
    }

    if (bothNodes.length === 0) {
      emit()
      return
    }
    const enumBoth = (d: number) => {
      if (d === bothNodes.length) {
        emit()
        return
      }
      for (const b of bothChoices[d]) {
        sinkB[bothNodes[d]] = b
        enumBoth(d + 1)
      }
    }
    enumBoth(0)
  }

  const dfs = (i: number) => {
    if (i === arcs.length) {
      leaf()
      return
    }
    for (let f = 0; f <= arcs[i].cap; f++) {
      flows[i] = f
      dfs(i + 1)
    }
  }
  dfs(0)
  return points
}

/**
 * 预言机口径的联合承诺裁决：在总值严格等于 fixedTotal 的全部可行流中，
 * 是否存在一组分配同时满足 y_k ≥ lower[k]（未给下限处视为 0）。
 * 不拼接单点区间、不比较承诺总和——直接对联合向量的可行点集合判定。
 */
export function oracleCommitmentsFeasible(
  net: Network,
  disabled: ReadonlySet<string>,
  fixedTotal: number,
  lower: readonly number[],
): boolean {
  const points = enumerateFeasibleFlows(net, disabled)
  return points.some(
    (p) =>
      p.total === fixedTotal &&
      p.sinkY.every((y, k) => y >= (lower[k] ?? 0)),
  )
}

/** 区间/承诺穷举用小整数网络：2..4 节点、1..5 管段（容量 0..3）、1..2 个供水/需求点。 */
export function smallIntegerNetwork(
  rng: () => number,
): Network {
  const nodeCount = 2 + Math.floor(rng() * 3) // 2..4
  const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`)
  const pick = () => ids[Math.floor(rng() * nodeCount)]
  const arcCount = 1 + Math.floor(rng() * 5) // 1..5
  const arcs = Array.from({ length: arcCount }, (_, i) => ({
    id: `a${i}`,
    from: pick(),
    to: pick(),
    capacity: Math.floor(rng() * 4), // 0..3
  }))
  const shuffled = [...ids]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  const srcCount = 1 + Math.floor(rng() * Math.min(2, nodeCount))
  const snkCount = 1 + Math.floor(rng() * Math.min(2, nodeCount))
  const sources = shuffled
    .slice(0, srcCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 5) }))
  const sinks = shuffled
    .slice(nodeCount - snkCount)
    .map((node) => ({ node, capacity: Math.floor(rng() * 5) }))
  return { nodes: ids.map((id) => ({ id })), arcs, sources, sinks }
}
