import { buildCalibrationAbPackageV2 } from './calibration-ab-pack-v2';
import { sceneDigest, type SceneCalibrationDataset } from './scene-calibration';

export const EPISTEMIC_GUARD_V3 = 'epistemic-guard.v3' as const;

const v2KnownRule = '1. [角色已知]、[公开事实基线]可作为当前确定信息；[角色信念]始终只是人物推断；[角色存疑]始终只是怀疑。';
const v3KnownRule = '1. [角色已知]、[公开事实基线]必须作为当前已经确定的信息表达，不得使用“我推测 / 我怀疑 / 尚未证实 / 拿不准”将其降级；[角色信念]始终只是人物推断；[角色存疑]始终只是怀疑。';

export function upgradeCalibrationPromptV3(prompt: string): string {
  if (!prompt.includes(v2KnownRule)) throw new Error('无法识别 epistemic-guard.v2 的已知信息规则');
  return prompt.replace(v2KnownRule, v3KnownRule);
}

export function buildCalibrationAbPackageV3(dataset: SceneCalibrationDataset, projectionRun: unknown, dryRun: unknown) {
  const base = buildCalibrationAbPackageV2(dataset, projectionRun, dryRun);
  const { packageId: derivedFromPackageId, ...basePayload } = base.packageData;
  const cases = base.packageData.cases.map((item) => {
    const prompts = { A: upgradeCalibrationPromptV3(item.prompts.A), B: upgradeCalibrationPromptV3(item.prompts.B) };
    return { ...item, prompts, promptHashes: { A: sceneDigest(prompts.A), B: sceneDigest(prompts.B) } };
  });
  const manifestPayload = {
    ...basePayload,
    version: '1.2' as const,
    derivedFromPackageId,
    promptPolicyVersion: EPISTEMIC_GUARD_V3,
    modelCalls: 0 as const,
    cases,
  };
  const packageData = { ...manifestPayload, packageId: sceneDigest(JSON.stringify(manifestPayload)) };
  const blindKeyPayload = {
    format: base.blindKey.format,
    version: '1.2' as const,
    packageId: packageData.packageId,
    mappings: base.blindKey.mappings,
  };
  const blindKey = { ...blindKeyPayload, keyId: sceneDigest(JSON.stringify(blindKeyPayload)) };
  const { sheetId: _oldSheetId, ...baseSheet } = base.blindSheet;
  const blindSheetPayload = {
    ...baseSheet,
    version: '1.2' as const,
    packageId: packageData.packageId,
    reviewStatus: 'not-run' as const,
    instructions: '先盲评 X/Y。硬门槛优先；同时检查信念是否升级为事实、已知是否降级成怀疑，以及是否自行编造依据。',
  };
  const blindSheet = { ...blindSheetPayload, sheetId: sceneDigest(JSON.stringify(blindSheetPayload)) };
  return { packageData, blindKey, blindSheet };
}
