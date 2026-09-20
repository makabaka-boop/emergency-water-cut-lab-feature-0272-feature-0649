import { PlanSolution } from './analyze'
import { findSinkIndex } from './interval'
import { FlowEdge, maxFlow } from './maxflow'

/**
 * 联合最低供水承诺（joint minimum commitments）。
 *
 * 工程师可为当前模型的多个需求点各填写一个最低供水量（0..该点容量的整数，
 * 可留空）。裁决针对**同一组建模边**回答：在
 *   - 每条边 0 ≤ f_e ≤ 容量（停用管段不在网络中），
 *   - 原节点（含超级源/汇）守恒成立，
 *   - 超级源 → 超级汇的总量**严格等于**当前 analysis.value
 * 三个条件同时成立时，全部需求边下限能否**一起**满足。
 *
 * 结论是多需求点的联合可行域问题：不能由单点区间拼接（各点区间端点来自
 * 不同环流，未必存在同一组流量同时取到），也不能只比较承诺总和（共享
 * 瓶颈可能在总量之内即否决）。
 *
 * 算法（固定总量下界环流）：
 *  1. 对每条承诺需求边 e=(v→T) 置下界 l_e = 承诺量，其余边下界为 0；
 *     把下界记为节点强制失衡 bal[v] -= l_e、bal[T] += l_e；
 *     各边在环流网络中只保留残差容量 c_e - l_e。
 *  2. 加入「汇 T → 源 S」回边，下界与上界都固定为当前总量 V
 *     （残差容量 0，只贡献失衡 bal[T] -= V、bal[S] += V）。
 *     回边把 S→…→T 的 V 个单位强制送回 S，于是环流中的可行流恰为
 *     总量严格等于 V 的原网络可行流。
 *  3. 加辅助超级源 SS、超级汇 TT：bal[u] > 0（下界净流入为正，需净流出）
 *     加 SS→u 容量 bal[u]；bal[u] < 0 加 u→TT 容量 -bal[u]。
 *     全部失衡可饱和（maxflow(SS→TT) = Σ bal[正]）当且仅当存在满足
 *     全部下界的环流，即全部承诺可同时兑现。
 *
 * 重边、原生反向边、自环、零容量边与同点供需均按 PlanEdge 输入身份
 * 独立参与建模（残差容量为 0 的边自然无弧可走）。
 */

export interface JointCommitment {
  /** network.sinks 中的下标。 */
  sinkIndex: number
  /** 最低供水量：0..该需求点容量 的整数。 */
  minimum: number
}

export type JointCommitmentResult =
  | {
      ok: true
      /** 全部承诺能否在固定总量下同时兑现。 */
      feasible: boolean
      /** 裁决所固定的超级源→超级汇总量（= 当前 analysis.value）。 */
      total: number
    }
  | {
      ok: false
      /** 失败原因（非空字符串），调用方就地提示并清除联合裁决。 */
      reason: string
    }

/** 按需求点下标裁决一组联合最低承诺。空承诺恒可行（总量固定为当前值）。 */
export function judgeCommitments(
  solution: PlanSolution,
  commitments: readonly JointCommitment[],
): JointCommitmentResult {
  const V = solution.analysis.value
  if (!Number.isSafeInteger(V) || V < 0) {
    return { ok: false, reason: '当前最大供水总量不是有效的非负整数' }
  }

  // 入参校验：下标合法、不重复，最低量为 0..该需求点容量 的整数。
  const lowerByEdge = new Map<number, number>()
  const seen = new Set<number>()
  for (const c of commitments) {
    if (
      !c ||
      !Number.isInteger(c.sinkIndex) ||
      c.sinkIndex < 0 ||
      c.sinkIndex >= solution.sinkEdgeIndex.length
    ) {
      return { ok: false, reason: '存在不属于当前模型的需求点' }
    }
    if (seen.has(c.sinkIndex)) {
      return { ok: false, reason: '同一需求点的最低量被重复填写' }
    }
    seen.add(c.sinkIndex)
    const m = c.minimum
    if (!Number.isSafeInteger(m) || m < 0) {
      return { ok: false, reason: '最低供水量必须是不小于 0 的整数' }
    }
    const edgeIndex = solution.sinkEdgeIndex[c.sinkIndex]
    const capacity = solution.edges[edgeIndex].capacity
    if (m > capacity) {
      return { ok: false, reason: `最低供水量超过该需求点容量 ${capacity}` }
    }
    if (m > 0) lowerByEdge.set(edgeIndex, m)
  }

  // 没有任何正向下界：零环流即可行（固定总量 V 本身由当前方案见证）。
  if (lowerByEdge.size === 0) {
    return { ok: true, feasible: true, total: V }
  }

  const N = solution.nodeCount
  const balance = new Float64Array(N)
  const auxEdges: FlowEdge[] = []

  // 各建模边：残差容量 c - l；下界 l 转换为端点强制失衡。
  for (let i = 0; i < solution.edges.length; i++) {
    const e = solution.edges[i]
    const l = lowerByEdge.get(i) ?? 0
    const reduced = e.capacity - l
    if (reduced < 0) {
      // 已由入参校验拦截，保留为求解异常的防御性分支。
      return { ok: false, reason: '需求边下界超过其容量' }
    }
    if (reduced > 0) {
      auxEdges.push({ from: e.from, to: e.to, capacity: reduced })
    }
    if (l > 0) {
      balance[e.from] -= l
      balance[e.to] += l
    }
  }

  // 汇→源回边固定承载 V（下界=上界=V）：残差容量为 0，仅贡献失衡。
  balance[solution.superSink] -= V
  balance[solution.superSource] += V

  // 辅助超级源/汇：强制全部下界失衡被补流饱和。
  const SS = N
  const TT = N + 1
  let required = 0
  for (let v = 0; v < N; v++) {
    const b = balance[v]
    if (b > 0) {
      auxEdges.push({ from: SS, to: v, capacity: b })
      required += b
    } else if (b < 0) {
      auxEdges.push({ from: v, to: TT, capacity: -b })
    }
  }

  let resValue: number
  try {
    resValue = maxFlow(N + 2, auxEdges, SS, TT).value
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
  if (!Number.isSafeInteger(resValue) || resValue < 0) {
    return { ok: false, reason: '辅助源汇求解结果不是有效的非负整数' }
  }

  return { ok: true, feasible: resValue === required, total: V }
}

/** 按需求点节点 id 裁决的便捷封装（id 不属于当前方案需求点时失败）。 */
export function judgeCommitmentsByNode(
  solution: PlanSolution,
  entries: readonly { node: string; minimum: number }[],
): JointCommitmentResult {
  const commitments: JointCommitment[] = []
  for (const entry of entries) {
    const idx = findSinkIndex(solution, entry.node)
    if (idx < 0) {
      return { ok: false, reason: `需求点 "${entry.node}" 不属于当前模型` }
    }
    commitments.push({ sinkIndex: idx, minimum: entry.minimum })
  }
  return judgeCommitments(solution, commitments)
}
