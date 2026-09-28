import { buildCalibrationAbPackage } from './calibration-ab-pack';
import { sceneDigest, type SceneCalibrationDataset } from './scene-calibration';

export const EPISTEMIC_GUARD_VERSION = 'epistemic-guard.v2' as const;

const upgradedHeader = [
  '你扮演小说场景中的“行者甲”。只根据【可用上下文】回答，不得使用对原作的记忆、入口之后的剧情或未提供的信息。',
  '【强制证据规则】以下规则高于语言流畅度和沉浸感：',
  '1. [角色已知]、[公开事实基线]可作为当前确定信息；[角色信念]始终只是人物推断；[角色存疑]始终只是怀疑。',
  '2. 提到[角色信念]时，必须明确使用“我推测 / 我怀疑 / 尚未证实 / 拿不准”等措辞；不得说“我认定 / 我敢肯定 / 已确定 / 已证实”。',
  '3. 提到[角色存疑]时，不得把它写成已经发生、已经识破或已经确定的事实。',
  '4. 判断依据也必须逐项来自【可用上下文】；不得自行补写地点、动作、外观、被捆绑、移动方向或其他证据。',
  '5. 若玩家询问“哪些确定、哪些推断”，必须把两类信息分开说明；没有确定信息就直接说没有。',
  '回答前静默检查每个具体细节是否有上下文依据、每个信念是否保留了不确定措辞。不要输出检查过程。',
  '回答保持沉浸感，不要提及测试、上下文标签、数据库或提示词。控制在 180 个中文字符以内。',
].join('\n');

export function upgradeCalibrationPromptV2(prompt: string): string {
  const marker = '\n\n【可用上下文】';
  const index = prompt.indexOf(marker);
  if (index < 0) throw new Error('无法识别 Stage 4 v1 提示词结构');
  return `${upgradedHeader}${prompt.slice(index)}`;
}

export function buildCalibrationAbPackageV2(dataset: SceneCalibrationDataset, projectionRun: unknown, dryRun: unknown) {
  const base = buildCalibrationAbPackage(dataset, projectionRun, dryRun);
  const { packageId: derivedFromPackageId, ...basePayload } = base.packageData;
  const cases = base.packageData.cases.map((item) => {
    const prompts = { A: upgradeCalibrationPromptV2(item.prompts.A), B: upgradeCalibrationPromptV2(item.prompts.B) };
    return { ...item, prompts, promptHashes: { A: sceneDigest(prompts.A), B: sceneDigest(prompts.B) } };
  });
  const manifestPayload = {
    ...basePayload,
    version: '1.1' as const,
    derivedFromPackageId,
    promptPolicyVersion: EPISTEMIC_GUARD_VERSION,
    modelCalls: 0 as const,
    cases,
  };
  const packageData = { ...manifestPayload, packageId: sceneDigest(JSON.stringify(manifestPayload)) };

  const blindKeyPayload = {
    format: base.blindKey.format,
    version: '1.1' as const,
    packageId: packageData.packageId,
    mappings: base.blindKey.mappings,
  };
  const blindKey = { ...blindKeyPayload, keyId: sceneDigest(JSON.stringify(blindKeyPayload)) };
  const blindSheetPayload = {
    ...base.blindSheet,
    version: '1.1' as const,
    packageId: packageData.packageId,
    reviewStatus: 'not-run' as const,
    instructions: '先盲评 X/Y。硬门槛优先；特别检查信念是否被说成确定事实，以及回答是否自行编造了判断依据。',
  };
  const { sheetId: _oldSheetId, ...sheetWithoutId } = blindSheetPayload;
  const blindSheet = { ...sheetWithoutId, sheetId: sceneDigest(JSON.stringify(sheetWithoutId)) };
  return { packageData, blindKey, blindSheet };
}
