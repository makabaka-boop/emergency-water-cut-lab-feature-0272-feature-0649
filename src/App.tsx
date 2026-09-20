import { ChangeEvent, useMemo, useState } from 'react'
import { relativeLoss, solvePlan, PlanSolution } from './core/analyze'
import { formatInt, formatPercent } from './core/format'
import { sinkIntervalByNode } from './core/interval'
import { initialLoaderState, reduceLoad } from './core/loader'
import { SAMPLE_TEXT } from './core/sample'
import { Analysis, CutItem, CutKind, Model, SinkInterval } from './core/types'

const KIND_LABEL: Record<CutKind, string> = {
  source: '供水点',
  arc: '管段',
  sink: '需求点',
}

const PAGE_SIZE = 100

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** 复核报告：自包含（含网络与方案），可脱离页面独立重算验证。 */
function buildReport(
  kind: 'baseline' | 'drill',
  model: Model,
  analysis: Analysis,
) {
  return {
    report: kind,
    generatedAt: new Date().toISOString(),
    network: model.network,
    disabledArcIds: analysis.disabled,
    maxSupply: analysis.value,
    cut: analysis.cut,
    loss: model.baseline.value - analysis.value,
    relativeLoss: relativeLoss(model.baseline.value, analysis.value),
  }
}

function CutTable({
  cut,
  onDisableArc,
}: {
  cut: CutItem[]
  onDisableArc?: (id: string) => void
}) {
  if (cut.length === 0) {
    return <p className="muted">割项为空（当前网络无源侧到汇侧的割边）。</p>
  }
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>类别</th>
          <th>ID</th>
          <th>起点 → 终点</th>
          <th className="num">容量</th>
          {onDisableArc && <th>操作</th>}
        </tr>
      </thead>
      <tbody>
        {cut.map((item) => (
          <tr key={`${item.kind}:${item.id}`}>
            <td>{KIND_LABEL[item.kind]}</td>
            <td className="mono">{item.id}</td>
            <td className="mono">
              {item.kind === 'arc' ? `${item.from} → ${item.to}` : '—'}
            </td>
            <td className="num mono">{formatInt(item.capacity)}</td>
            {onDisableArc && (
              <td>
                {item.kind === 'arc' && (
                  <button
                    className="link-btn"
                    onClick={() => onDisableArc(item.id)}
                  >
                    停用
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ValueBlock({
  label,
  value,
  suffix,
}: {
  label: string
  value: string
  suffix?: string
}) {
  return (
    <div className="value-block">
      <div className="value-label">{label}</div>
      <div className="value-number mono">
        {value}
        {suffix && <span className="value-suffix">{suffix}</span>}
      </div>
    </div>
  )
}

/**
 * 避难点供水区间面板：工程师从当前模型的需求点中选择一个，
 * 显示保持当前最大供水总量不变时，该点可获水量的最小值、
 * 当前 Dinic 方案值、最大值。当前值仅为一组可行分配。
 *
 * 辅助求解失败（含所选需求点在当前模型中不存在）时就地提示，
 * 不影响已成功的核算/演练结果。
 */
function SinkIntervalPanel({
  sinks,
  selected,
  onSelect,
  interval,
  failed,
}: {
  sinks: Model['network']['sinks']
  selected: string
  onSelect: (id: string) => void
  interval: SinkInterval | null
  failed: string | null
}) {
  return (
    <div className="interval-box">
      <div className="interval-toolbar">
        <label>选择避难点（需求点）</label>
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
        >
          {sinks.map((k) => (
            <option key={k.node} value={k.node}>
              {k.node}（需求能力 {formatInt(k.capacity)}）
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p className="interval-error" role="alert">
          供水区间求解失败：{failed}。已清除旧区间，核算与演练结果不受影响。
        </p>
      )}
      {!failed && interval && (
        <>
          <div className="value-row">
            <ValueBlock label="最小可获水量" value={formatInt(interval.min)} />
            <ValueBlock label="当前 Dinic 方案" value={formatInt(interval.current)} />
            <ValueBlock label="最大可获水量" value={formatInt(interval.max)} />
          </div>
          <p className="muted interval-note">
            区间在最大供水总量保持 {formatInt(interval.total)} 不变的前提下成立，
            端点均不突破容量与节点守恒；当前 Dinic 方案值{' '}
            {formatInt(interval.current)} 只是总值 {formatInt(interval.total)}{' '}
            下的一组可行分配，并非唯一答案。
          </p>
        </>
      )}
    </div>
  )
}

export default function App() {
  const [loader, setLoader] = useState(initialLoaderState)
  const [text, setText] = useState('')
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  // 工程师当前选中的需求点节点 id（基线与演练共用一个选择）。
  const [selectedSink, setSelectedSink] = useState('')

  const model = loader.model

  const loadText = (t: string) => {
    setLoader((prev) => reduceLoad(prev, t))
  }

  // 模型更换（引用变化）时清空演练方案与已选需求点，从基线重新开始。
  // 载入新模型使旧选择失效：区间随之清除（由下方 useMemo 重算）。
  const [prevModel, setPrevModel] = useState(model)
  if (model !== prevModel) {
    setPrevModel(model)
    setDisabled(new Set())
    setFilter('')
    setPage(0)
    setSelectedSink('')
  }

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then(loadText)
    e.target.value = ''
  }

  // 基线方案解（含建模边身份与正反残量），供区间分析复用。
  const baselineSolution: PlanSolution | null = useMemo(() => {
    if (!model) return null
    return solvePlan(model.network, new Set())
  }, [model])

  // 空方案直接复用基线解，保证「清空方案」逐项精确回到基线（引用相同）。
  const currentSolution: PlanSolution | null = useMemo(() => {
    if (!model) return null
    return disabled.size === 0
      ? baselineSolution
      : solvePlan(model.network, disabled)
  }, [model, disabled, baselineSolution])

  // 空方案直接复用基线结果，保证「清空方案」逐项精确回到基线。
  const analysis: Analysis | null = currentSolution
    ? currentSolution.analysis
    : null

  // 已选需求点在新模型中不存在（如载入新模型后）→ 选择落回第一个需求点；
  // 无需求点时留空（面板不渲染）。
  const effectiveSink =
    model && model.network.sinks.some((k) => k.node === selectedSink)
      ? selectedSink
      : model && model.network.sinks.length > 0
        ? model.network.sinks[0].node
        : ''

  // 区间求解就地容错：辅助求解失败时清除旧区间并提示，
  // 不抛错、不影响已成功的基线核算与演练结果。
  const computeInterval = (
    solution: PlanSolution | null,
    nodeId: string,
  ): { interval: SinkInterval | null; failed: string | null } => {
    if (!solution || !nodeId) return { interval: null, failed: null }
    try {
      const result = sinkIntervalByNode(solution, nodeId)
      if (result.ok) {
        const interval: SinkInterval = {
          sinkNode: result.sinkNode,
          current: result.current,
          min: result.min,
          max: result.max,
          total: result.total,
        }
        return { interval, failed: null }
      }
      return { interval: null, failed: result.reason }
    } catch (err) {
      return {
        interval: null,
        failed: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const baselineIntervalState = useMemo(
    () => computeInterval(baselineSolution, effectiveSink),
    [baselineSolution, effectiveSink],
  )

  // 停用/恢复管段后，已选需求点按新断管集合与当前总量重算；
  // 清空方案时 currentSolution === baselineSolution，区间恢复为基线区间。
  const currentIntervalState = useMemo(
    () =>
      disabled.size === 0
        ? baselineIntervalState
        : computeInterval(currentSolution, effectiveSink),
    [currentSolution, effectiveSink, disabled.size, baselineIntervalState],
  )

  const filteredArcs = useMemo(() => {
    if (!model) return []
    const f = filter.trim()
    if (!f) return model.network.arcs
    return model.network.arcs.filter(
      (a) => a.id.includes(f) || a.from.includes(f) || a.to.includes(f),
    )
  }, [model, filter])

  const pageCount = Math.max(1, Math.ceil(filteredArcs.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageArcs = filteredArcs.slice(
    safePage * PAGE_SIZE,
    (safePage + 1) * PAGE_SIZE,
  )

  const toggleArc = (id: string) => {
    const next = new Set(disabled)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    setDisabled(next)
  }

  const clearPlan = () => setDisabled(new Set())

  return (
    <div className="page">
      <header className="page-header">
        <h1>暴雨断管 · 应急供水韧性评估</h1>
        <p className="muted">
          载入管网 JSON，核算基线最大供水量与瓶颈割项；逐项停用管段演练，
          实时得到当前供水量、相对损失与新割项。纯前端计算，无任何网络请求。
        </p>
      </header>

      <section className="card">
        <h2>一、载入网络</h2>
        <div className="load-actions">
          <label className="file-btn">
            选择 JSON 文件
            <input type="file" accept=".json,application/json" onChange={onFileChange} />
          </label>
          <button onClick={() => { setText(SAMPLE_TEXT); loadText(SAMPLE_TEXT) }}>
            载入内置示例
          </button>
          <button onClick={() => loadText(text)}>解析文本框内容</button>
        </div>
        <textarea
          className="json-input mono"
          spellCheck={false}
          placeholder='粘贴网络 JSON：{"nodes":[...],"arcs":[...],"sources":[...],"sinks":[...]}'
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {loader.error && (
          <div className="error-banner" role="alert">
            <strong className="mono">{loader.error.code}</strong>
            <span className="muted">（已保留上次模型）</span>
            <ul>
              {loader.error.details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}
        {model ? (
          <p className="muted stats-line">
            当前模型：节点 {formatInt(model.network.nodes.length)} · 管段{' '}
            {formatInt(model.network.arcs.length)} · 供水点{' '}
            {model.network.sources.length} · 需求点 {model.network.sinks.length}
          </p>
        ) : (
          <p className="muted">尚未载入有效模型。</p>
        )}
      </section>

      {model && analysis && (
        <>
          <section className="card">
            <div className="card-head">
              <h2>二、基线核算</h2>
              <button
                onClick={() =>
                  downloadJson('baseline-report.json', buildReport('baseline', model, model.baseline))
                }
              >
                导出基线复核报告
              </button>
            </div>
            <div className="value-row">
              <ValueBlock
                label="基线最大供水量"
                value={formatInt(model.baseline.value)}
              />
              <ValueBlock
                label="割项数量"
                value={formatInt(model.baseline.cut.length)}
              />
            </div>
            <h3>残量网络源侧 → 汇侧割项</h3>
            <CutTable cut={model.baseline.cut} />

            {model.network.sinks.length > 0 && (
              <>
                <h3>避难点供水区间（基线）</h3>
                <SinkIntervalPanel
                  sinks={model.network.sinks}
                  selected={effectiveSink}
                  onSelect={setSelectedSink}
                  interval={baselineIntervalState.interval}
                  failed={baselineIntervalState.failed}
                />
              </>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>三、断管演练</h2>
              <div className="head-actions">
                <button onClick={clearPlan} disabled={disabled.size === 0}>
                  清空方案（回到基线）
                </button>
                <button
                  onClick={() =>
                    downloadJson('drill-report.json', buildReport('drill', model, analysis))
                  }
                >
                  导出演练复核报告
                </button>
              </div>
            </div>

            <div className="value-row">
              <ValueBlock
                label="当前最大供水量"
                value={formatInt(analysis.value)}
              />
              <ValueBlock
                label="绝对损失"
                value={formatInt(model.baseline.value - analysis.value)}
              />
              <ValueBlock
                label="相对损失"
                value={formatPercent(
                  relativeLoss(model.baseline.value, analysis.value),
                )}
              />
              <ValueBlock label="已停用管段" value={String(disabled.size)} />
            </div>
            {disabled.size === 0 && (
              <p className="muted">当前为空方案，结果与基线逐项一致。</p>
            )}
            {disabled.size > 0 && (
              <div className="chips">
                {analysis.disabled.map((id) => (
                  <button
                    key={id}
                    className="chip mono"
                    title="点击恢复该管段"
                    onClick={() => toggleArc(id)}
                  >
                    {id} ✕
                  </button>
                ))}
              </div>
            )}

            {model.network.sinks.length > 0 && (
              <>
                <h3>避难点供水区间（当前方案）</h3>
                <SinkIntervalPanel
                  sinks={model.network.sinks}
                  selected={effectiveSink}
                  onSelect={setSelectedSink}
                  interval={currentIntervalState.interval}
                  failed={currentIntervalState.failed}
                />
                {disabled.size === 0 && (
                  <p className="muted">空方案下区间与基线区间一致。</p>
                )}
              </>
            )}

            <h3>当前割项</h3>
            <CutTable cut={analysis.cut} onDisableArc={toggleArc} />

            <h3>管段清单（勾选停用）</h3>
            <div className="arc-toolbar">
              <input
                type="search"
                placeholder="按 id / 起点 / 终点过滤"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value)
                  setPage(0)
                }}
              />
              <span className="muted">
                命中 {formatInt(filteredArcs.length)} 条 · 第 {safePage + 1} /{' '}
                {pageCount} 页
              </span>
              <button
                disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)}
              >
                上一页
              </button>
              <button
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)}
              >
                下一页
              </button>
            </div>
            <table className="data-table">
              <thead>
                <tr>
                  <th>停用</th>
                  <th>ID</th>
                  <th>起点 → 终点</th>
                  <th className="num">容量</th>
                </tr>
              </thead>
              <tbody>
                {pageArcs.map((arc) => (
                  <tr
                    key={arc.id}
                    className={disabled.has(arc.id) ? 'row-disabled' : ''}
                  >
                    <td>
                      <input
                        type="checkbox"
                        checked={disabled.has(arc.id)}
                        onChange={() => toggleArc(arc.id)}
                      />
                    </td>
                    <td className="mono">{arc.id}</td>
                    <td className="mono">
                      {arc.from} → {arc.to}
                    </td>
                    <td className="num mono">{formatInt(arc.capacity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      <footer className="muted footer">
        计算口径：超级源→供水点（供水能力）、原管段、需求点→超级汇（需求能力）的最大流；
        割项为残量网络中源侧可达集到汇侧的供水点/管段/需求点边，按类别与 id（UTF-16 升序）排列。
      </footer>
    </div>
  )
}
