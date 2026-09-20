import { LoadError, Model } from './types'
import { parseNetwork } from './validate'
import { analyze } from './analyze'

/** 页面加载状态：模型与错误互斥地更新（非法输入保留上次模型）。 */
export interface LoaderState {
  model: Model | null
  error: LoadError | null
}

export const initialLoaderState: LoaderState = { model: null, error: null }

/**
 * 载入一段 JSON 文本：
 *  - 合法 → 替换模型（并重算基线），清空错误；
 *  - 非法 → 返回 INVALID_NETWORK 错误，原模型原样保留（引用不变）。
 */
export function reduceLoad(state: LoaderState, text: string): LoaderState {
  const result = parseNetwork(text)
  if (!result.ok) {
    return { model: state.model, error: result.error }
  }
  const network = result.network
  return {
    model: { network, baseline: analyze(network, new Set()) },
    error: null,
  }
}
