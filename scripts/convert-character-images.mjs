import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImagePipeline, parseCliArguments as parseSharedCliArguments } from './image-conversion-pipeline.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DELIVERY_SIZE = 512;
export const DELIVERY_QUALITY = 85;
export const DELIVERY_ALPHA_QUALITY = 100;
export const DELIVERY_EFFORT = 6;
export const DEFAULT_INPUT_DIRECTORY = path.join(repositoryRoot, '.character-sources');
export const OUTPUT_DIRECTORY = path.join(repositoryRoot, 'static', 'characters');
export const CACHE_STATE_PATH = path.join(repositoryRoot, '.character-image-cache.json');
export const PIPELINE_CONFIG = Object.freeze({ width: DELIVERY_SIZE, height: DELIVERY_SIZE, format: 'webp', fit: 'contain', position: 'center', background: { r: 0, g: 0, b: 0, alpha: 0 }, quality: DELIVERY_QUALITY, alphaQuality: DELIVERY_ALPHA_QUALITY, effort: DELIVERY_EFFORT, withoutEnlargement: true, preserveSmallSources: true });
const pipeline = createImagePipeline({ repositoryRoot, defaultInputDirectory: DEFAULT_INPUT_DIRECTORY, outputDirectory: OUTPUT_DIRECTORY, cachePath: CACHE_STATE_PATH, signatureConfig: PIPELINE_CONFIG, config: { ...PIPELINE_CONFIG, trim: false, webp: { quality: DELIVERY_QUALITY, alphaQuality: DELIVERY_ALPHA_QUALITY, effort: DELIVERY_EFFORT }, validateSourceMetadata(metadata) {
	if (!metadata.format) throw new Error('image format is unavailable');
	if (metadata.format.toLowerCase() === 'webp') throw new Error('WebP source files are not accepted; regenerate from the high-resolution original');
	if (metadata.width === undefined || metadata.height === undefined) throw new Error('image dimensions are unavailable');
	const warnings = [];
	if (metadata.width <= DELIVERY_SIZE || metadata.height <= DELIVERY_SIZE) warnings.push(`source dimensions are at or below ${DELIVERY_SIZE}px; preserving the original dimensions (${metadata.width}x${metadata.height})`);
	if (metadata.hasAlpha !== true) warnings.push('source image has no alpha channel; converting without alpha');
	return warnings;
} } });
export const PIPELINE_SIGNATURE = pipeline.pipelineSignature;
export const runPipeline = pipeline.run;
export function parseCliArguments(argumentsList) { const parsed = parseSharedCliArguments(argumentsList); return { inputDirectory: parsed.inputDirectory ?? DEFAULT_INPUT_DIRECTORY, force: parsed.force }; }
function printSummary(summary) { console.log(`Scanned: ${summary.scanned}`); console.log(`Generated: ${summary.generated}`); console.log(`Updated: ${summary.updated}`); console.log(`Skipped: ${summary.skipped}`); console.log(`Failed: ${summary.failed}`); for (const warning of summary.warnings) console.warn(`Warning: ${warning}`); console.log(`Output: ${summary.outputDirectory}`); }
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) { const main = async () => { const summary = await runPipeline(parseCliArguments(process.argv.slice(2))); printSummary(summary); if (summary.errors.length) { for (const error of summary.errors) console.error(`Error: ${error}`); process.exitCode = 1; } }; main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }); }
