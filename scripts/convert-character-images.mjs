import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');

export const DELIVERY_SIZE = 512;
export const DELIVERY_QUALITY = 85;
export const DELIVERY_ALPHA_QUALITY = 100;
export const DELIVERY_EFFORT = 6;
export const DEFAULT_INPUT_DIRECTORY = path.join(repositoryRoot, '.character-sources');
export const OUTPUT_DIRECTORY = path.join(repositoryRoot, 'static', 'characters');
export const CACHE_STATE_PATH = path.join(repositoryRoot, '.character-image-cache.json');
export const PIPELINE_CONFIG = Object.freeze({
	width: DELIVERY_SIZE,
	height: DELIVERY_SIZE,
	format: 'webp',
	fit: 'contain',
	position: 'center',
	background: { r: 0, g: 0, b: 0, alpha: 0 },
	quality: DELIVERY_QUALITY,
	alphaQuality: DELIVERY_ALPHA_QUALITY,
	effort: DELIVERY_EFFORT,
	withoutEnlargement: true,
	preserveSmallSources: true
});
export const PIPELINE_SIGNATURE = createHash('sha256').update(JSON.stringify(PIPELINE_CONFIG)).digest('hex');

function describePath(filePath) {
	const relativePath = path.relative(repositoryRoot, filePath);
	return relativePath && !relativePath.startsWith('..') ? relativePath : filePath;
}

async function readSourceMetadata(sourcePath) {
	try {
		return await sharp(await readFile(sourcePath)).metadata();
	} catch (error) {
		throw new Error(`cannot decode image (${error instanceof Error ? error.message : String(error)})`);
	}
}

async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function validateSourceMetadata(metadata) {
	if (!metadata.format) {
		throw new Error('image format is unavailable');
	}
	if (metadata.format.toLowerCase() === 'webp') {
		throw new Error('WebP source files are not accepted; regenerate from the high-resolution original');
	}
	if (metadata.width === undefined || metadata.height === undefined) {
		throw new Error('image dimensions are unavailable');
	}
	const warnings = [];
	if (metadata.width <= DELIVERY_SIZE || metadata.height <= DELIVERY_SIZE) {
		warnings.push(`source dimensions are at or below ${DELIVERY_SIZE}px; preserving the original dimensions (${metadata.width}x${metadata.height})`);
	}
	if (metadata.hasAlpha !== true) {
		warnings.push('source image has no alpha channel; converting without alpha');
	}
	return warnings;
}

async function validateDeliveryImage(outputPath, expectedWidth = DELIVERY_SIZE, expectedHeight = DELIVERY_SIZE) {
	try {
		const metadata = await sharp(await readFile(outputPath)).metadata();
		return (
			metadata.format?.toLowerCase() === 'webp' &&
			metadata.width === expectedWidth &&
			metadata.height === expectedHeight
		);
	} catch {
		return false;
	}
}

async function fileExists(filePath) {
	try {
		await access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function replaceOutput(tempPath, outputPath) {
	try {
		await rename(tempPath, outputPath);
	} catch (error) {
		if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) {
			throw error;
		}
		await rm(outputPath, { force: true });
		await rename(tempPath, outputPath);
	}
}

async function loadCache(cachePath) {
	try {
		const parsed = JSON.parse(await readFile(cachePath, 'utf8'));
		if (parsed?.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null || Array.isArray(parsed.entries)) {
			return { version: 1, entries: {} };
		}
		return { version: 1, entries: parsed.entries };
	} catch {
		return { version: 1, entries: {} };
	}
}

async function saveCache(cachePath, entries) {
	const tempPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(tempPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
		await replaceOutput(tempPath, cachePath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

async function convertOne(sourcePath, outputPath, metadata) {
	const tempPath = path.join(
		path.dirname(outputPath),
		`.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
	);

	try {
		const image = sharp(sourcePath);
		const shouldResize = metadata.width > DELIVERY_SIZE || metadata.height > DELIVERY_SIZE;
		if (shouldResize) {
			image.resize({
				width: PIPELINE_CONFIG.width,
				height: PIPELINE_CONFIG.height,
				fit: PIPELINE_CONFIG.fit,
				position: PIPELINE_CONFIG.position,
				...(metadata.hasAlpha === true ? { background: PIPELINE_CONFIG.background } : {}),
				withoutEnlargement: PIPELINE_CONFIG.withoutEnlargement
			});
		}
		await image
			.webp({
				quality: PIPELINE_CONFIG.quality,
				alphaQuality: PIPELINE_CONFIG.alphaQuality,
				effort: PIPELINE_CONFIG.effort
			})
			.toFile(tempPath);

		const expectedWidth = shouldResize ? DELIVERY_SIZE : metadata.width;
		const expectedHeight = shouldResize ? DELIVERY_SIZE : metadata.height;
		if (!(await validateDeliveryImage(tempPath, expectedWidth, expectedHeight))) {
			throw new Error('generated output failed WebP or expected dimensions validation');
		}

		await replaceOutput(tempPath, outputPath);
	} finally {
		await rm(tempPath, { force: true });
	}
}

async function collectSources(inputDirectory) {
	let entries;
	try {
		entries = await readdir(inputDirectory, { withFileTypes: true });
	} catch (error) {
		throw new Error(`cannot read input directory ${describePath(inputDirectory)} (${error instanceof Error ? error.message : String(error)})`);
	}

	const sources = entries
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const sourcePath = path.join(inputDirectory, entry.name);
			const basename = path.parse(entry.name).name;
			return {
				basename,
				sourcePath
			};
		})
		.sort((first, second) => first.sourcePath.localeCompare(second.sourcePath));

	const collisions = new Map();
	for (const source of sources) {
		const key = source.basename.toLowerCase();
		const collision = collisions.get(key) ?? { basename: source.basename, paths: [] };
		collision.paths.push(source.sourcePath);
		collisions.set(key, collision);
	}

	const collisionMessages = [...collisions.entries()]
		.filter(([, collision]) => collision.paths.length > 1)
		.map(([, collision]) => `basename "${collision.basename}" maps to multiple outputs: ${collision.paths.map(describePath).join(', ')}`);

	if (collisionMessages.length > 0) {
		throw new Error(`input validation failed:\n- ${collisionMessages.join('\n- ')}`);
	}

	const validationResults = await Promise.all(
		sources.map(async (source) => {
			try {
				const metadata = await readSourceMetadata(source.sourcePath);
				const warnings = validateSourceMetadata(metadata);
				return { source: { ...source, metadata }, warnings, error: null };
			} catch (error) {
				return { source, warnings: [], error: error instanceof Error ? error.message : String(error) };
			}
		})
	);

	const invalidSources = validationResults.filter((result) => result.error !== null);
	if (invalidSources.length > 0) {
		throw new Error(
			`input validation failed:\n${invalidSources
				.map(({ source, error }) => `- ${describePath(source.sourcePath)}: ${error}`)
				.join('\n')}`
		);
	}

	return {
		sources: validationResults.map(({ source }) => source),
		warnings: validationResults.flatMap(({ source, warnings }) =>
			warnings.map((warning) => `${describePath(source.sourcePath)}: ${warning}`)
		)
	};
}

export async function runPipeline({
	inputDirectory = DEFAULT_INPUT_DIRECTORY,
	outputDirectory = OUTPUT_DIRECTORY,
	cachePath = CACHE_STATE_PATH,
	force = false
} = {}) {
	const resolvedInputDirectory = path.resolve(inputDirectory);
	const resolvedOutputDirectory = path.resolve(outputDirectory);
	const resolvedCachePath = path.resolve(cachePath);
	if (resolvedInputDirectory === DEFAULT_INPUT_DIRECTORY && !(await fileExists(resolvedInputDirectory))) {
		await mkdir(resolvedInputDirectory, { recursive: true });
	}
	const { sources, warnings } = await collectSources(resolvedInputDirectory);
	await mkdir(resolvedOutputDirectory, { recursive: true });
	const sourcesWithHashes = await Promise.all(
		sources.map(async (source) => ({ ...source, sourceHash: await sha256File(source.sourcePath) }))
	);
	const cache = await loadCache(resolvedCachePath);
	const cacheEntries = { ...cache.entries };
	let cacheChanged = false;

	const summary = {
		scanned: sources.length,
		generated: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		outputDirectory: resolvedOutputDirectory,
		errors: [],
		warnings
	};

	for (const source of sourcesWithHashes) {
		const outputPath = path.join(resolvedOutputDirectory, `${source.basename}.webp`);
		const outputExists = await fileExists(outputPath);
		const hadOutputBeforeConversion = outputExists;
		let shouldSkip = false;

		const expectedWidth = source.metadata.width > DELIVERY_SIZE ? DELIVERY_SIZE : source.metadata.width;
		const expectedHeight = source.metadata.height > DELIVERY_SIZE ? DELIVERY_SIZE : source.metadata.height;
		if (!force && outputExists && (await validateDeliveryImage(outputPath, expectedWidth, expectedHeight))) {
			const cacheEntry = cacheEntries[source.basename];
			if (
				cacheEntry?.pipelineSignature === PIPELINE_SIGNATURE &&
				cacheEntry.sourceSha256 === source.sourceHash
			) {
				shouldSkip = cacheEntry.outputSha256 === (await sha256File(outputPath));
			}
		}

		if (shouldSkip) {
			summary.skipped += 1;
			continue;
		}

		try {
			await convertOne(source.sourcePath, outputPath, source.metadata);
			const outputHash = await sha256File(outputPath);
			cacheEntries[source.basename] = {
				sourceSha256: source.sourceHash,
				outputSha256: outputHash,
				pipelineSignature: PIPELINE_SIGNATURE
			};
			cacheChanged = true;
			if (hadOutputBeforeConversion) {
				summary.updated += 1;
			} else {
				summary.generated += 1;
			}
		} catch (error) {
			summary.failed += 1;
			summary.errors.push(`${describePath(source.sourcePath)}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	if (cacheChanged) {
		try {
			await saveCache(resolvedCachePath, cacheEntries);
		} catch (error) {
			summary.failed += 1;
			summary.errors.push(`cache ${resolvedCachePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return summary;
}

export function parseCliArguments(argumentsList) {
	let inputDirectory;
	let force = false;

	for (const argument of argumentsList) {
		if (argument === '--force') {
			force = true;
			continue;
		}
		if (argument.startsWith('-')) {
			throw new Error(`unknown option: ${argument}`);
		}
		if (inputDirectory !== undefined) {
			throw new Error('only one input directory may be specified');
		}
		inputDirectory = path.resolve(process.cwd(), argument);
	}

	return { inputDirectory: inputDirectory ?? DEFAULT_INPUT_DIRECTORY, force };
}

function printSummary(summary) {
	console.log(`Scanned: ${summary.scanned}`);
	console.log(`Generated: ${summary.generated}`);
	console.log(`Updated: ${summary.updated}`);
	console.log(`Skipped: ${summary.skipped}`);
	console.log(`Failed: ${summary.failed}`);
	for (const warning of summary.warnings) {
		console.warn(`Warning: ${warning}`);
	}
	console.log(`Output: ${summary.outputDirectory}`);
}

async function main() {
	const options = parseCliArguments(process.argv.slice(2));
	const summary = await runPipeline(options);
	printSummary(summary);
	if (summary.errors.length > 0) {
		for (const error of summary.errors) {
			console.error(`Error: ${error}`);
		}
		process.exitCode = 1;
	}
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
