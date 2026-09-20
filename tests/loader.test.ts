import { describe, expect, it } from 'vitest'
import { initialLoaderState, reduceLoad } from '../src/core/loader'
import { SAMPLE_TEXT } from '../src/core/sample'

const TINY = JSON.stringify({
  nodes: [{ id: 's' }, { id: 't' }],
  arcs: [{ id: 'e', from: 's', to: 't', capacity: 5 }],
  sources: [{ node: 's', capacity: 5 }],
  sinks: [{ node: 't', capacity: 5 }],
})

describe('载入状态机', () => {
  it('合法文本：替换模型并核算基线', () => {
    const state = reduceLoad(initialLoaderState, TINY)
    expect(state.error).toBeNull()
    expect(state.model).not.toBeNull()
    expect(state.model!.baseline.value).toBe(5)
    expect(state.model!.baseline.disabled).toEqual([])
  })

  it('非法文本：INVALID_NETWORK 且保留上次模型（引用不变）', () => {
    const loaded = reduceLoad(initialLoaderState, TINY)
    const model = loaded.model
    const failed = reduceLoad(loaded, '{broken')
    expect(failed.error?.code).toBe('INVALID_NETWORK')
    expect(failed.model).toBe(model)

    // 契约层面的非法同样保留模型
    const failed2 = reduceLoad(loaded, '{"nodes":[],"arcs":[],"sources":[]}')
    expect(failed2.error?.code).toBe('INVALID_NETWORK')
    expect(failed2.model).toBe(model)
  })

  it('再次载入合法文本：替换模型并清除错误', () => {
    let state = reduceLoad(initialLoaderState, TINY)
    state = reduceLoad(state, '{broken')
    expect(state.error).not.toBeNull()
    state = reduceLoad(state, SAMPLE_TEXT)
    expect(state.error).toBeNull()
    expect(state.model!.baseline.value).toBeGreaterThan(0)
  })

  it('内置示例本身合法且可复算', () => {
    const state = reduceLoad(initialLoaderState, SAMPLE_TEXT)
    expect(state.error).toBeNull()
    const baseline = state.model!.baseline
    // 示例：供给 115 = 需求 115，管网可全部送达
    expect(baseline.value).toBe(115)
    const cutSum = baseline.cut.reduce((s, c) => s + c.capacity, 0)
    expect(cutSum).toBe(baseline.value)
  })
})
