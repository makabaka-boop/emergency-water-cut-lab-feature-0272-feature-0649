import { describe, expect, it } from 'vitest'
import { solvePlan } from '../src/core/analyze'
import {
  JointCommitment,
  judgeCommitments,
  judgeCommitmentsByNode,
} from '../src/core/commitment'
import { Network } from '../src/core/types'
import { buildLargeNetwork, mulberry32 } from './helpers'
import {
  enumerateFeasibleFlows,
  oracleCommitmentsFeasible,
  smallIntegerNetwork,
} from './oracle'

/**
 * 联合最低供水承诺测试。
 *
 * 预言机：枚举小整数网络在「固定最大总量」下的全部可行流（oracle.ts），
 * 直接对联合向量判定是否存在一组分配同时满足全部下限——不拼接单点区间、
 * 不比较承诺总和。
 */

/** 按 network.sinks 下标构造承诺列表（自动跳过 null 项，模拟留空）。 */
function commitmentsFromArray(
  lower: readonly (number | null)[],
): JointCommitment[] {
  const out: JointCommitment[] = []
  lower.forEach((m, k) => {
    if (m !== null) out.push({ sinkIndex: k, minimum: m })
  })
  return out
}

describe('联合最低供水承诺：穷举固定总量全部可行流作为预言机', () => {
  it('小整数网络中，全部 0..容量 的下限组合裁决均与穷举预言机一致（含重边/反向边/自环/零容量/供需同点/随机断管）', () => {
    const rng = mulberry32(20260920)
    const ROUNDS = 160
    let checked = 0
    for (let round = 0; round < ROUNDS; round++) {
      const net = smallIntegerNetwork(rng)
      const disabled = new Set<string>()
      if (rng() < 0.5) {
        net.arcs.forEach((a) => {
          if (rng() < 0.3) disabled.add(a.id)
        })
      }
      const solution = solvePlan(net, disabled)
      const V = solution.analysis.value

      // 为每个需求点取若干候选下限（0..容量），再枚举其笛卡尔积，
      // 小网络（≤2 个需求点、容量 ≤4）下组合数很小。
      const candidates: number[][] = net.sinks.map((k) => {
        const set = new Set<number>([0, k.capacity])
        // 加入当前 Dinic 方案值与区间中部，增加与当前解交互的覆盖。
        const edgeIndex = solution.sinkEdgeIndex[net.sinks.indexOf(k)]
        set.add(solution.flow[edgeIndex])
        if (k.capacity > 0) set.add(Math.floor(k.capacity / 2))
        return [...set].sort((a, b) => a - b)
      })

      const combos: (number | null)[][] = [[]]
      for (let k = 0; k < net.sinks.length; k++) {
        const next: (number | null)[][] = []
        for (const prefix of combos) {
          next.push([...prefix, null]) // 该项留空
          for (const m of candidates[k]) next.push([...prefix, m])
        }
        combos.length = 0
        combos.push(...next)
      }

      for (const combo of combos) {
        const commitments = commitmentsFromArray(combo)
        const result = judgeCommitments(solution, commitments)
        expect(result.ok).toBe(true)
        if (!result.ok) continue
        expect(result.total).toBe(V)

        const denseLower = net.sinks.map((_, k) => combo[k] ?? 0)
        const oracle = oracleCommitmentsFeasible(net, disabled, V, denseLower)
        expect(result.feasible, `round=${round} combo=${JSON.stringify(combo)} V=${V}`).toBe(
          oracle,
        )
        checked++
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('可行裁决只报告联合可行与固定总量；不存在「承诺量之和超总量」这类捷径误判', () => {
    const rng = mulberry32(99)
    for (let round = 0; round < 40; round++) {
      const net = smallIntegerNetwork(rng)
      const solution = solvePlan(net, new Set())
      const V = solution.analysis.value
      // 承诺量之和不超过总量，但仍可能因局部瓶颈不可行（反之亦可能可行）。
      const points = enumerateFeasibleFlows(net, new Set()).filter(
        (p) => p.total === V,
      )
      if (points.length === 0) continue
      for (let k = 0; k < net.sinks.length; k++) {
        const cap = net.sinks[k].capacity
        for (let m = 0; m <= cap; m++) {
          const result = judgeCommitments(solution, [{ sinkIndex: k, minimum: m }])
          expect(result.ok).toBe(true)
          if (!result.ok) continue
          // 单点承诺可行 ⇔ 该点在某个固定总量可行流中达到 m。
          const oracle = points.some((p) => p.sinkY[k] >= m)
          expect(result.feasible).toBe(oracle)
          expect(result.total).toBe(V)
        }
      }
    }
  })
})

describe('联合最低供水承诺：锁定共享瓶颈场景', () => {
  /**
   * 共享容量 5：d1、d2 需求容量各 5。各承诺 3 虽分别落在 0..5 的单点
   * 区间内（且 3+3=6 超过固定总量 5 这一简单口径之外，还要验证局部瓶颈），
   * 联合裁决必须判不可行。
   *
   * 随后加入一条独立通路向 d3 供水 5（总量升至 10）：承诺和 6 ≤ 10，
   * 但 d1/d2 仍共享容量 5（3+3=6 > 5），局部瓶颈依旧否决——
   * 证明「承诺和未超总量」不足以推出可行。
   */
  function sharedBottleNetwork(withD3: boolean): Network {
    const nodes = [{ id: 's' }, { id: 'm' }, { id: 'd1' }, { id: 'd2' }]
    const arcs = [
      { id: 'p', from: 's', to: 'm', capacity: 5 },
      { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
      { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
    ]
    const sinks: Network['sinks'] = [
      { node: 'd1', capacity: 5 },
      { node: 'd2', capacity: 5 },
    ]
    if (withD3) {
      nodes.push({ id: 's2' }, { id: 'd3' })
      arcs.push({ id: 'p3', from: 's2', to: 'd3', capacity: 5 })
      sinks.push({ node: 'd3', capacity: 5 })
    }
    const sources: Network['sources'] = [{ node: 's', capacity: 100 }]
    if (withD3) sources.push({ node: 's2', capacity: 5 })
    return { nodes, arcs, sources, sinks }
  }

  it('共享容量 5：d1、d2 各承诺 3 虽分别落在 0..5 区间，联合裁决不可行', () => {
    const net = sharedBottleNetwork(false)
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(5)

    // 单点区间各自都允许 3（0..5），但不存在同一组流量同时取 3+3。
    const r1 = judgeCommitments(solution, [{ sinkIndex: 0, minimum: 3 }])
    const r2 = judgeCommitments(solution, [{ sinkIndex: 1, minimum: 3 }])
    expect(r1).toMatchObject({ ok: true, feasible: true, total: 5 })
    expect(r2).toMatchObject({ ok: true, feasible: true, total: 5 })

    const joint = judgeCommitments(solution, [
      { sinkIndex: 0, minimum: 3 },
      { sinkIndex: 1, minimum: 3 },
    ])
    expect(joint).toMatchObject({ ok: true, feasible: false, total: 5 })

    // 预言机一致：固定总量 5 的可行流里没有 y1≥3 且 y2≥3 的点。
    expect(
      oracleCommitmentsFeasible(net, new Set(), 5, [3, 3]),
    ).toBe(false)
    // 但 (2,3)、(3,2) 可行，说明并非总量或单点区间否决。
    expect(
      oracleCommitmentsFeasible(net, new Set(), 5, [2, 3]),
    ).toBe(true)
    expect(
      oracleCommitmentsFeasible(net, new Set(), 5, [3, 2]),
    ).toBe(true)
  })

  it('加入独立向 d3 供水 5（总量 10）：承诺和 6 未超总量，局部瓶颈仍否决 d1/d2 各 3', () => {
    const net = sharedBottleNetwork(true)
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(10)

    const joint = judgeCommitmentsByNode(solution, [
      { node: 'd1', minimum: 3 },
      { node: 'd2', minimum: 3 },
    ])
    expect(joint).toMatchObject({ ok: true, feasible: false, total: 10 })

    // 承诺和 6 ≤ 固定总量 10，仍不可行：d1/d2 共享的容量 5 才是瓶颈。
    expect(
      oracleCommitmentsFeasible(net, new Set(), 10, [3, 3, 0]),
    ).toBe(false)

    // d3 自身承诺 5 可与 d1、d2 的可行分摊同时兑现（如 (2,3,5)）。
    const withD3 = judgeCommitmentsByNode(solution, [
      { node: 'd1', minimum: 2 },
      { node: 'd2', minimum: 3 },
      { node: 'd3', minimum: 5 },
    ])
    expect(withD3).toMatchObject({ ok: true, feasible: true, total: 10 })
    expect(
      oracleCommitmentsFeasible(net, new Set(), 10, [2, 3, 5]),
    ).toBe(true)

    // 只要求 d3=5：可行（d1/d2 可任意分摊 5）。
    const d3only = judgeCommitmentsByNode(solution, [
      { node: 'd3', minimum: 5 },
    ])
    expect(d3only).toMatchObject({ ok: true, feasible: true })
  })
})

describe('联合最低供水承诺：断管重算、清空与裁决生命周期', () => {
  const net: Network = {
    nodes: [{ id: 's' }, { id: 'm' }, { id: 'd1' }, { id: 'd2' }],
    arcs: [
      { id: 'p', from: 's', to: 'm', capacity: 5 },
      { id: 'q1', from: 'm', to: 'd1', capacity: 5 },
      { id: 'q2', from: 'm', to: 'd2', capacity: 5 },
    ],
    sources: [{ node: 's', capacity: 100 }],
    sinks: [
      { node: 'd1', capacity: 5 },
      { node: 'd2', capacity: 5 },
    ],
  }

  it('停用管段改变总量后按新网络与当前总量重新裁决', () => {
    // 基线：总量 5，(3,2) 可行。
    const base = solvePlan(net, new Set())
    expect(
      judgeCommitments(base, [
        { sinkIndex: 0, minimum: 3 },
        { sinkIndex: 1, minimum: 2 },
      ]),
    ).toMatchObject({ ok: true, feasible: true, total: 5 })

    // 停用 q2：总量仍为 5 但只能进 d1 → d1≥5、d2 必为 0。
    const cut = solvePlan(net, new Set(['q2']))
    expect(cut.analysis.value).toBe(5)
    expect(
      judgeCommitments(cut, [{ sinkIndex: 0, minimum: 3 }]),
    ).toMatchObject({ ok: true, feasible: true, total: 5 })
    expect(
      judgeCommitments(cut, [{ sinkIndex: 1, minimum: 1 }]),
    ).toMatchObject({ ok: true, feasible: false, total: 5 })
    expect(
      oracleCommitmentsFeasible(net, new Set(['q2']), 5, [0, 1]),
    ).toBe(false)

    // 停用 p：总量降为 0，任何正承诺都不可行，零承诺可行。
    const cutP = solvePlan(net, new Set(['p']))
    expect(cutP.analysis.value).toBe(0)
    expect(
      judgeCommitments(cutP, [{ sinkIndex: 0, minimum: 0 }]),
    ).toMatchObject({ ok: true, feasible: true, total: 0 })
    expect(
      judgeCommitments(cutP, [{ sinkIndex: 0, minimum: 1 }]),
    ).toMatchObject({ ok: true, feasible: false, total: 0 })
  })

  it('清空方案（停用集合为空）后裁决与基线逐项一致', () => {
    const commitments: JointCommitment[] = [
      { sinkIndex: 0, minimum: 4 },
      { sinkIndex: 1, minimum: 1 },
    ]
    const drilled = solvePlan(net, new Set(['q1']))
    expect(drilled.analysis.value).toBe(5)
    // q1 停用：d1 拿不到水，d1≥4 不可行。
    expect(judgeCommitments(drilled, commitments)).toMatchObject({
      ok: true,
      feasible: false,
    })
    const cleared = solvePlan(net, new Set())
    expect(cleared.analysis).toEqual(solvePlan(net, new Set()).analysis)
    expect(judgeCommitments(cleared, commitments)).toMatchObject({
      ok: true,
      feasible: true,
      total: 5,
    })
  })

  it('裁决对同一组边流量：容量、守恒与严格总量均为前提', () => {
    // 承诺之和严格大于固定总量必不可行（回边把总量钉死为 analysis.value）。
    const solution = solvePlan(net, new Set())
    const overTotal = judgeCommitments(solution, [
      { sinkIndex: 0, minimum: 5 },
      { sinkIndex: 1, minimum: 1 },
    ])
    expect(overTotal).toMatchObject({ ok: true, feasible: false, total: 5 })
    expect(
      oracleCommitmentsFeasible(net, new Set(), 5, [5, 1]),
    ).toBe(false)
  })
})

describe('联合最低供水承诺：无效填写与辅助求解失败隔离', () => {
  const net: Network = {
    nodes: [{ id: 's' }, { id: 't' }],
    arcs: [{ id: 'e', from: 's', to: 't', capacity: 3 }],
    sources: [{ node: 's', capacity: 5 }],
    sinks: [{ node: 't', capacity: 3 }],
  }

  it('非整数 / 负数 / 超过该点容量的填写返回失败（不产出可行/不可行裁决）', () => {
    const solution = solvePlan(net, new Set())
    expect(judgeCommitments(solution, [{ sinkIndex: 0, minimum: 1.5 }])).toMatchObject({
      ok: false,
    })
    expect(judgeCommitments(solution, [{ sinkIndex: 0, minimum: -1 }])).toMatchObject({
      ok: false,
    })
    expect(judgeCommitments(solution, [{ sinkIndex: 0, minimum: 4 }])).toMatchObject({
      ok: false,
    })
    expect(Number.isSafeInteger(9007199254740991)).toBe(true)
    expect(
      judgeCommitments(solution, [{ sinkIndex: 0, minimum: 9007199254740991 }]),
    ).toMatchObject({ ok: false })
  })

  it('越界下标 / 不存在的需求点 id / 重复填写返回失败且不抛出', () => {
    const solution = solvePlan(net, new Set())
    expect(judgeCommitments(solution, [{ sinkIndex: 5, minimum: 0 }])).toMatchObject({
      ok: false,
    })
    expect(judgeCommitments(solution, [{ sinkIndex: -1, minimum: 0 }])).toMatchObject({
      ok: false,
    })
    expect(
      judgeCommitmentsByNode(solution, [{ node: 'ghost', minimum: 0 }]),
    ).toMatchObject({ ok: false })
    expect(
      judgeCommitments(solution, [
        { sinkIndex: 0, minimum: 0 },
        { sinkIndex: 0, minimum: 1 },
      ]),
    ).toMatchObject({ ok: false })
  })

  it('空承诺（全部留空）恒为可行，固定总量为当前 analysis.value；基线/演练不受失败影响', () => {
    const base = solvePlan(net, new Set())
    expect(judgeCommitments(base, [])).toEqual({
      ok: true,
      feasible: true,
      total: 3,
    })
    expect(judgeCommitmentsByNode(base, [])).toEqual({
      ok: true,
      feasible: true,
      total: 3,
    })
    // 失败裁决之后，同一方案仍可正常裁决有效承诺，基线 Analysis 未被触碰。
    const bad = judgeCommitments(base, [{ sinkIndex: 0, minimum: 99 }])
    expect(bad.ok).toBe(false)
    expect(base.analysis.value).toBe(3)
    expect(
      judgeCommitments(base, [{ sinkIndex: 0, minimum: 3 }]),
    ).toMatchObject({ ok: true, feasible: true })
  })

  it('零容量需求点只能填写 0；填正值被判无效（而非不可行）', () => {
    const zeroNet: Network = {
      nodes: [{ id: 's' }, { id: 'z' }, { id: 't' }],
      arcs: [{ id: 'e', from: 's', to: 't', capacity: 2 }],
      sources: [{ node: 's', capacity: 5 }],
      sinks: [
        { node: 'z', capacity: 0 },
        { node: 't', capacity: 2 },
      ],
    }
    const solution = solvePlan(zeroNet, new Set())
    expect(
      judgeCommitments(solution, [{ sinkIndex: 0, minimum: 0 }]),
    ).toMatchObject({ ok: true, feasible: true })
    expect(
      judgeCommitments(solution, [{ sinkIndex: 0, minimum: 1 }]),
    ).toMatchObject({ ok: false })
  })
})

describe('联合最低供水承诺：重边 / 原生反向边 / 自环 / 零容量 / 供需同点', () => {
  it('特殊边按 PlanEdge 输入身份参与，裁决与穷举一致', () => {
    const rng = mulberry32(20260921)
    for (let round = 0; round < 80; round++) {
      const net = smallIntegerNetwork(rng)
      const solution = solvePlan(net, new Set())
      const V = solution.analysis.value
      // 随机一组下限组合（含留空）。
      const combo = net.sinks.map((_k, kIdx) => {
        const r = rng()
        if (r < 0.3) return null
        const edgeIndex = solution.sinkEdgeIndex[kIdx]
        const cap = solution.edges[edgeIndex].capacity
        return Math.floor(rng() * (cap + 1))
      })
      const dense = net.sinks.map((_, k) => combo[k] ?? 0)
      const result = judgeCommitments(solution, commitmentsFromArray(combo))
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.total).toBe(V)
      expect(result.feasible).toBe(
        oracleCommitmentsFeasible(net, new Set(), V, dense),
      )
    }
  })

  it('同一节点兼作供水点与需求点：其需求边承诺独立裁决', () => {
    const net: Network = {
      nodes: [{ id: 'x' }, { id: 't' }],
      arcs: [{ id: 'e', from: 'x', to: 't', capacity: 10 }],
      sources: [{ node: 'x', capacity: 6 }],
      sinks: [
        { node: 'x', capacity: 2 },
        { node: 't', capacity: 10 },
      ],
    }
    const solution = solvePlan(net, new Set())
    expect(solution.analysis.value).toBe(6)
    // x 就地消化 0..2、t 得 4..6；要求 x≥2 且 t≥4 可行，t≥5 仍可行，t≥6 与 x≥1 冲突。
    expect(
      judgeCommitments(solution, [
        { sinkIndex: 0, minimum: 2 },
        { sinkIndex: 1, minimum: 4 },
      ]),
    ).toMatchObject({ ok: true, feasible: true, total: 6 })
    expect(
      judgeCommitments(solution, [
        { sinkIndex: 0, minimum: 1 },
        { sinkIndex: 1, minimum: 6 },
      ]),
    ).toMatchObject({ ok: true, feasible: false, total: 6 })
    expect(
      oracleCommitmentsFeasible(net, new Set(), 6, [1, 6]),
    ).toBe(false)
    expect(
      oracleCommitmentsFeasible(net, new Set(), 6, [2, 4]),
    ).toBe(true)
  })
})

describe('联合最低供水承诺：性能', () => {
  it('10000 节点 / 50000 管段的一次联合校验（方案重算 + 辅助源汇）四秒内完成', () => {
    const net = buildLargeNetwork()
    const solution = solvePlan(net, new Set())
    const V = solution.analysis.value
    const commitments = net.sinks
      .filter((_, k) => k % 25 === 0)
      .map((_, j) => ({ sinkIndex: j * 25, minimum: 1000 }))

    const start = performance.now()
    const result = judgeCommitments(solution, commitments)
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(4000)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.total).toBe(V)
  })
})
