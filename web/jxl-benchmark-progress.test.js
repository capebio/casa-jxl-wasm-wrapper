import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
    formatBenchmarkFileStatus,
    formatBenchmarkProgress,
    formatLoadFileStatus,
    formatLoadProgress,
} from './jxl-benchmark-progress.js';

const benchmarkSource = readFileSync(new URL('./jxl-benchmark.js', import.meta.url), 'utf8');
const benchmarkHtml = readFileSync(new URL('./jxl-benchmark.html', import.meta.url), 'utf8');
const benchmarkCss = readFileSync(new URL('./jxl-benchmark.css', import.meta.url), 'utf8');

test('formatLoadProgress reports incremental loaded file count', () => {
    expect(formatLoadProgress({ loadedCount: 2, totalCount: 5 })).toBe('Loaded 2/5 files...');
});

test('formatLoadFileStatus reports current load position and file name', () => {
    expect(formatLoadFileStatus({ currentIndex: 3, totalCount: 5, fileName: 'desert.orf' })).toBe('Loading 3/5: desert.orf');
});

test('formatBenchmarkProgress reports percent plus completed file counter', () => {
    expect(formatBenchmarkProgress({
        percent: 42,
        size: 1080,
        quality: 85,
        effort: 3,
        completedFiles: 2,
        totalFiles: 5,
    })).toBe('42% - 1080px q=85 e=3 (files 2/5)');
});

test('formatBenchmarkFileStatus reports completed file counter and active file name', () => {
    expect(formatBenchmarkFileStatus({ completedFiles: 2, totalFiles: 5, fileName: 'scene-03.orf' })).toBe('Files 2/5 complete - scene-03.orf');
});

test('benchmark page uses live counter formatters during file load and benchmark run', () => {
    expect(benchmarkSource).toContain("formatLoadProgress({");
    expect(benchmarkSource).toContain("formatLoadFileStatus({");
    expect(benchmarkSource).toContain("formatBenchmarkProgress({");
    expect(benchmarkSource).toContain("formatBenchmarkFileStatus({");
});

test('benchmark and clear buttons stay disabled until files are loaded', () => {
    expect(benchmarkHtml).toContain('<button id="start-benchmark" class="primary-btn" type="button" disabled');
    expect(benchmarkHtml).toContain('<button id="clear-results" class="secondary-btn" type="button" disabled');
    expect(benchmarkSource).toContain('clearResultsBtn.disabled = !ready;');
});

test('disabled primary buttons have disabled styling', () => {
    expect(benchmarkCss).toContain('.primary-btn:disabled');
});

test('benchmark exposes detailed timing breakdowns in tables and exports', () => {
    expect(benchmarkSource).toContain('resizeMs: new Map()');
    expect(benchmarkSource).toContain('firstChunkMs: new Map()');
    expect(benchmarkSource).toContain('totalMs: new Map()');
    expect(benchmarkSource).toContain('recordTiming(benchmarkResults.resizeMs, key, resizeMs)');
    expect(benchmarkSource).toContain('recordTiming(benchmarkResults.firstChunkMs, key, encResult.firstChunkMs)');
    expect(benchmarkSource).toContain('recordTiming(benchmarkResults.totalMs, key, totalMs)');
    expect(benchmarkSource).toContain('firstChunkMs: firstChunkMs ?? encodeMs');
    expect(benchmarkSource).toContain('Resize avg');
    expect(benchmarkSource).toContain('First chunk avg');
    expect(benchmarkSource).toContain('Total avg');
    expect(benchmarkSource).toContain('detailTimingLine(');
    expect(benchmarkSource).toContain('appendTimingBreakdownCsv(csvRows)');
    expect(benchmarkHtml).toContain('<th>First chunk avg</th>');
    expect(benchmarkHtml).toContain('<th>Total avg</th>');
});
