import { useEffect, useState } from 'react';
import type { LocalFoundationResult } from './shared/local-foundation';

export function LocalFoundationResults({ runId, onUpgraded }: { runId: string; onUpgraded?: () => Promise<void> }) {
  const [result, setResult] = useState<LocalFoundationResult | null>(null);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  useEffect(() => {
    let active = true;
    setResult(null); setEntry(''); setError(''); setOutput('');
    void window.novelCompiler.getLocalFoundationResult(runId).then(value => { if (active) setResult(value); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [runId]);
  async function exportFiles() {
    setBusy(true); setError('');
    try {
      const value = await window.novelCompiler.exportLocalFoundation({ runId, entryOrdinal: entry ? Number(entry) : undefined });
      setOutput(`${value.outputPath}（${value.characterCount} 张卡／${value.worldEntryCount} 条世界书）`);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function upgrade() {
    setBusy(true); setError('');
    try {
      await window.novelCompiler.upgradeLocalFoundation(runId);
      await onUpgraded?.();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <section className="panel local-foundation-results">
    <h3>极低档生成结果</h3>
    <p>人物、事实、对白、时间、章节场景、地点、关系图与成品包由本地流程生成；细节可以继续精修，生成不调用 API。</p>
    {result && <>
      <p>候选 {result.candidateCount} 项，原文证据 {result.evidenceCount} 条，角色卡 {result.characters.length} 张。生成用量：0 API 请求／0 API Token。</p>
      {result.integrated ? <p><strong>工程与可游玩整合包已生成。</strong>可到角色卡制作、世界书和书库查看，再选择入口阅读或进入酒馆。</p>
        : <div className="foundation-warning"><p>这是上一版本的独立素材结果，尚未接通工程与游玩流程。</p><button className="button primary" disabled={busy} onClick={() => void upgrade()}>复用已有扫描，补齐工程与游玩流程</button></div>}
      <div className="foundation-controls">
        <label><span>导出范围</span><select value={entry} onChange={e => setEntry(e.target.value)}>
          <option value="">全书资料草稿（含后续剧情）</option>
          {result.chapters.map((chapter, index) => <option key={index} value={chapter.endOrdinal}>截至 {chapter.title} 结束 · 第 {chapter.endOrdinal} 段</option>)}
        </select></label>
        <button className="button primary" disabled={busy} onClick={() => void exportFiles()}>{busy ? '正在导出…' : '导出并打开文件夹'}</button>
      </div>
      <p>这里导出的是独立素材副本。应用内阅读和酒馆使用完整流程生成的可游玩包，可另选较早入口。极低档以原文顺序控制范围，倒叙、预言和角色知情范围仍需复核。</p>
      <details><summary>查看候选角色与原文覆盖</summary>{result.characters.map(person => <p key={person.name}><strong>{person.name}</strong>：涉及 {person.mentions} 段，首次提及第 {person.firstOrdinal} 段</p>)}</details>
      <small>输出位置：{output || result.outputPath}</small>
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
