import { defaultApiRequestSettings, type ApiRequestSettings } from './shared/api-request-settings';

type Props = { value: ApiRequestSettings; onChange: (value: ApiRequestSettings) => void };
export function ApiRequestFields({ value, onChange }: Props) {
  const update = <K extends keyof ApiRequestSettings>(key: K, next: ApiRequestSettings[K]) => onChange({ ...value, [key]: next });
  const numeric = (key: keyof ApiRequestSettings, label: string, help: string, min: number, max: number, step = 1, nullable = false) => <label className="request-field" key={key}>
    <span>{label}</span><input aria-label={label} type="number" required={!nullable} min={min} max={max} step={step} placeholder={nullable ? '自动 / 不指定' : ''}
      value={typeof value[key] === 'number' && Number.isFinite(value[key]) ? value[key] as number : ''}
      onChange={event => update(key, event.target.value === '' ? (nullable ? null : NaN) : Number(event.target.value))} />
    <small>{help}</small>
  </label>;
  return <div className="request-settings">
    <div className="request-settings-intro"><div><span className="eyebrow">REQUEST PREFERENCES</span><h3>让模型按你的参数工作</h3></div>
      <button type="button" className="button ghost" onClick={() => onChange(structuredClone(defaultApiRequestSettings))}>恢复参数默认值</button></div>
    <p className="request-settings-note">参数保存后供编译器后续请求使用；失败的任务可保存后从失败处重试。SillyTavern 的聊天参数仍在它自己的调节页面设置。</p>
    <fieldset><legend>01 · 输出长度</legend><p>这里填写的是每次请求允许生成的 Token 数，不是账户额度。程序不再限定为 12,000；可用范围以服务商和具体模型为准，填大不会扩大模型本身的能力。</p>
      <div className="request-field-grid">
        {numeric('jsonMaxTokens', '分析输出上限（Token）', '人物、事实、时间、关系、地点及角色卡等 JSON 生成请求。', 1, 2147483647)}
        {numeric('censusRetryMaxTokens', '截断重试上限（Token）', '批量分析被截断后，每次翻倍至此值。须 ≥ 分析输出上限；设为相同值可关闭自动增长。', 1, 2147483647)}
        {numeric('textMaxTokens', '试聊输出上限（Token）', '编译器角色试聊及其改写请求使用；不影响 SillyTavern。', 1, 2147483647)}
        {numeric('timeoutSeconds', '单次请求超时（秒）', '5–3600 秒。长输出或思考模式通常需要更长等待时间。', 5, 3600)}
      </div>
    </fieldset>
    <fieldset><legend>02 · 采样与重复控制</legend><p>留空保留自动行为。手动填写的值会原样发送，兼容重试也不会擅自删除；服务商不支持时会返回具体错误。</p>
      <div className="request-field-grid">
        {numeric('jsonTemperature', '分析温度 Temperature', '留空按模型适配；值越高，生成通常越多样。', 0, 2, 0.01, true)}
        {numeric('textTemperature', '试聊温度 Temperature', '只用于编译器文本试聊。', 0, 2, 0.01, true)}
        {numeric('topP', '核采样 Top P', '0–1；留空不发送。通常只重点调整温度或 Top P 其中一项。', 0, 1, 0.01, true)}
        {numeric('frequencyPenalty', '频率惩罚 Frequency penalty', '−2 到 2；留空不发送。正值抑制高频重复。', -2, 2, 0.01, true)}
        {numeric('presencePenalty', '出现惩罚 Presence penalty', '−2 到 2；留空不发送。正值降低重复使用已出现内容的倾向。', -2, 2, 0.01, true)}
        {numeric('seed', '随机种子 Seed', '可选非负整数。是否支持及可复现程度由服务商决定。', 0, 2147483647, 1, true)}
      </div>
    </fieldset>
    <fieldset><legend>03 · 思考模式与兼容性</legend>
      <div className="request-field-grid">
        <label className="request-field"><span>思考模式 Thinking</span><select aria-label="思考模式 Thinking" value={value.thinking} onChange={event => update('thinking', event.target.value as ApiRequestSettings['thinking'])}>
          <option value="auto">自动 · 按模型适配</option><option value="omit">不发送该参数</option><option value="enabled">开启</option><option value="disabled">关闭</option></select><small>服务商需支持 thinking 参数；自动模式沿用现有模型适配。</small></label>
        <label className="request-field"><span>思考强度 Reasoning effort</span><select aria-label="思考强度 Reasoning effort" value={value.reasoningEffort} onChange={event => update('reasoningEffort', event.target.value as ApiRequestSettings['reasoningEffort'])}>
          <option value="auto">自动 · 按模型适配</option><option value="omit">不发送该参数</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select><small>可用档位因模型而异；思考可能占用生成预算。</small></label>
        <label className="request-field"><span>JSON 响应模式</span><select aria-label="JSON 响应模式" value={value.jsonMode} onChange={event => update('jsonMode', event.target.value as ApiRequestSettings['jsonMode'])}>
          <option value="auto">自动 · 优先 JSON，可兼容回退</option><option value="required">始终发送 JSON 模式</option><option value="off">不发送 JSON 模式参数</option></select><small>无论是否发送参数，分析结果仍必须通过完整 JSON 和数据校验。</small></label>
        <label className="request-field"><span>可选参数兼容重试</span><select aria-label="可选参数兼容重试" value={String(value.compatibilityFallback)} onChange={event => update('compatibilityFallback', event.target.value === 'true')}>
          <option value="true">开启</option><option value="false">关闭</option></select><small>只在服务商明确拒绝自动参数时回退；手动指定的参数保持不变。</small></label>
      </div>
    </fieldset>
    <fieldset><legend>04 · 批量分析重试</legend><p>用于人物普查、人物事实、事件、关系和地点分析。角色试聊的输出审核与单次角色卡操作保持各自流程。</p>
      <div className="request-field-grid">
        {numeric('maxAttempts', '最大尝试次数（含首次）', '1–10 次。设为 1 表示不自动重试；兼容参数回退可能额外发起请求。', 1, 10)}
        {numeric('retryDelayMs', '重试基础间隔（毫秒）', '0–60000 毫秒，后续等待按尝试序号递增。', 0, 60000)}
      </div>
    </fieldset>
    <fieldset><legend>05 · 默认输入分块</legend><p>单位是原文字符，模型实际输入还包括提示词和资料。这些值用于新分块；已有工程请到“分析分块”生成新方案后再开始新的分析，失败重试仍使用任务原先锁定的分块。</p>
      <div className="request-field-grid">
        {([['coreChars', '核心目标（字符）', 1000, 50000], ['softLimit', '软上限（字符）', 1000, 60000], ['hardLimit', '硬上限（字符）', 1000, 80000], ['overlapBefore', '前文重叠（字符）', 0, 5000], ['overlapAfter', '后文重叠（字符）', 0, 5000]] as const).map(([key, label, min, max]) => <label className="request-field" key={key}><span>{label}</span><input aria-label={label} type="number" required min={min} max={max} step={1} value={Number.isFinite(value.inputChunks[key]) ? value.inputChunks[key] : ''} onChange={event => update('inputChunks', { ...value.inputChunks, [key]: event.target.value === '' ? NaN : Number(event.target.value) })} /><small>{min.toLocaleString()}–{max.toLocaleString()} 字符；核心 ≤ 软上限 ≤ 硬上限。</small></label>)}
      </div>
    </fieldset>
  </div>;
}
