import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImagePipeline, parseCliArguments } from './image-conversion-pipeline.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DELIVERY_SIZE = 256;
export const DEFAULT_INPUT_DIRECTORY = path.join(repositoryRoot, '.field-object-sources');
export const OUTPUT_DIRECTORY = path.join(repositoryRoot, 'static', 'field', 'objects');
export const CACHE_STATE_PATH = path.join(repositoryRoot, '.field-object-image-cache.json');
export const PIPELINE_CONFIG = Object.freeze({ width: DELIVERY_SIZE, height: DELIVERY_SIZE, format: 'webp', fit: 'contain', position: 'center', background: { r: 0, g: 0, b: 0, alpha: 0 }, lossless: true, effort: 6, withoutEnlargement: false, trim: true });
const pipeline = createImagePipeline({ repositoryRoot, defaultInputDirectory: DEFAULT_INPUT_DIRECTORY, outputDirectory: OUTPUT_DIRECTORY, cachePath: CACHE_STATE_PATH, config: { ...PIPELINE_CONFIG, webp: { lossless: true, effort: 6 }, validateSourceMetadata(metadata) {
	if (!metadata.format) throw new Error('image format is unavailable');
	if (metadata.width === undefined || metadata.height === undefined) throw new Error('image dimensions are unavailable');
	if (metadata.hasAlpha !== true) throw new Error('source image must have an alpha channel');
	return [];
} } });
export const PIPELINE_SIGNATURE = pipeline.pipelineSignature;
export const runPipeline = pipeline.run;
function printSummary(summary) { console.log(`Scanned: ${summary.scanned}`); console.log(`Generated: ${summary.generated}`); console.log(`Updated: ${summary.updated}`); console.log(`Skipped: ${summary.skipped}`); console.log(`Failed: ${summary.failed}`); console.log(`Output: ${summary.outputDirectory}`); }
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) { const main = async () => { const summary = await runPipeline(parseCliArguments(process.argv.slice(2))); printSummary(summary); if (summary.errors.length) { for (const error of summary.errors) console.error(`Error: ${error}`); process.exitCode = 1; } }; main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }); }
