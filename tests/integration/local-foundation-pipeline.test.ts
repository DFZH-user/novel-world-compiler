import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { LocalFoundationService } from '../../electron/worker/local-foundation-service';
import { PlayableBundleValidationService } from '../../electron/worker/playable-bundle-validation-service';
import { PlaySessionPreparationService } from '../../electron/worker/play-session-preparation-service';

describe('zero API local project pipeline', () => {
  it.each([true, false])('completes normal workbench and playable assets (named places: %s)', async namedPlaces => {
    // Tiny synthetic fixtures stay in the isolated D: checkout, never in user novels or C: temp.
    const checkRoot = path.resolve('.local-check');
    await fs.mkdir(checkRoot, { recursive: true });
    const fixture = await fs.mkdtemp(path.join(checkRoot, 'pipeline-'));
    const store = new ProjectStore();
    const network = vi.fn(() => { throw new Error('Local generation must not use the network'); });
    vi.stubGlobal('fetch', network);
    try {
      const source = path.join(fixture, 'synthetic.txt');
      const place = namedPlaces ? '青石村' : '这里';
      await fs.writeFile(source, `第一章 初见\n林舟和沈月来到${place}。\n林舟说道：“明天我们再见。”\n沈月回答：“好的。”\n第二章 重逢\n第二天，林舟和沈月在${place}重逢。\n林舟告诉沈月最后一页的暗号是晚秋青灯。\n`, 'utf8');
      await store.create('本地脚本虚构检查', path.join(fixture, 'check.novelworld'));
      await new Importer(store).run(source, 'utf8');
      const workflows = new FoundationWorkflowService(store);
      const started = workflows.create('', 'local', null, { names: '林舟,沈月', maxCards: 2 });
      const local = new LocalFoundationService(store);
      let run = workflows.get(started.runId);
      for (let n = 0; n < 60 && run.state === 'running'; n++) run = await local.next(run.id);
      expect(run.state).toBe('completed');
      expect(run.steps.every(step => step.state === 'completed')).toBe(true);
      expect(local.result(run.id).integrated).toBe(true);
      const db = store.get().db;
      for (const table of ['character_chunk_results', 'person_mentions', 'character_facts', 'character_fact_clusters', 'character_quotes', 'character_quote_attributions', 'timeline_time_expressions', 'timeline_event_chunk_results', 'timeline_event_sources', 'timeline_events', 'place_identities', 'character_relationships']) {
        expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBeGreaterThan(0);
      }
      const summary = JSON.parse(run.steps.find(step => step.stepKey === 'summary')!.outputJson!) as { playableBundle: { packageDirectory: string } };
      const validation = new PlayableBundleValidationService(store);
      const report = await validation.validate(summary.playableBundle.packageDirectory);
      expect(report.issues.filter(issue => issue.severity === 'error')).toEqual([]);
      expect(report.valid).toBe(true);
      const preparation = new PlaySessionPreparationService(validation, store);
      expect(await preparation.prepare(summary.playableBundle.packageDirectory)).toBeTruthy();
      const earliest = db.prepare("SELECT id FROM timeline_events WHERE review_status = 'confirmed' ORDER BY narrative_start_ordinal LIMIT 1").get() as { id: string };
      expect(JSON.stringify(preparation.prepareLive(earliest.id))).not.toContain('晚秋青灯');
      if (namedPlaces) {
        // Exercise the old local-only result upgrade without a second discovery/evidence scan.
        db.prepare("UPDATE foundation_workflow_steps SET output_json = '{}' WHERE run_id = ? AND step_key = 'summary'").run(run.id);
        expect(local.result(run.id).integrated).toBe(false);
        const upgraded = local.upgrade(run.id);
        expect(db.prepare('SELECT phase FROM local_foundation_runs WHERE run_id = ?').get(upgraded.runId)).toMatchObject({ phase: 'integrate' });
        let upgradedRun = workflows.get(upgraded.runId);
        for (let n = 0; n < 20 && upgradedRun.state === 'running'; n++) upgradedRun = await local.next(upgraded.runId);
        expect(upgradedRun.state).toBe('completed');
        expect(local.result(upgraded.runId).integrated).toBe(true);
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await store.close();
      // Verify the resolved recursive-delete target stays inside our dedicated fixture directory.
      if (!path.resolve(fixture).startsWith(checkRoot + path.sep)) throw new Error('Unsafe fixture path');
      await fs.rm(fixture, { recursive: true, force: true });
    }
  });
});
