import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
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
	if (metadata.width <= DELIVERY_SIZE || metadata.height <= DELIVERY_SIZE) {
		throw new Error(`source dimensions must both be greater than ${DELIVERY_SIZE}px (received ${metadata.width}x${metadata.height})`);
	}
	if (metadata.hasAlpha !== true) {
		throw new Error('source image must have an alpha channel');
	}
}

async function validateDeliveryImage(outputPath) {
	try {
		const metadata = await sharp(await readFile(outputPath)).metadata();
		return (
			metadata.format?.toLowerCase() === 'webp' &&
			metadata.width === DELIVERY_SIZE &&
			metadata.height === DELIVERY_SIZE &&
			metadata.hasAlpha === true
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

async function convertOne(sourcePath, outputPath) {
	const tempPath = path.join(
		path.dirname(outputPath),
		`.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`
	);

	try {
		await sharp(sourcePath)
			.resize({
				width: DELIVERY_SIZE,
				height: DELIVERY_SIZE,
				fit: 'contain',
				position: 'center',
				background: { r: 0, g: 0, b: 0, alpha: 0 },
				withoutEnlargement: true
			})
			.webp({
				quality: DELIVERY_QUALITY,
				alphaQuality: DELIVERY_ALPHA_QUALITY,
				effort: DELIVERY_EFFORT
			})
			.toFile(tempPath);

		if (!(await validateDeliveryImage(tempPath))) {
			throw new Error('generated output failed WebP, 512x512, or alpha validation');
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
		const paths = collisions.get(source.basename) ?? [];
		paths.push(source.sourcePath);
		collisions.set(source.basename, paths);
	}

	const collisionMessages = [...collisions.entries()]
		.filter(([, paths]) => paths.length > 1)
		.map(([basename, paths]) => `basename "${basename}" maps to multiple outputs: ${paths.map(describePath).join(', ')}`);

	if (collisionMessages.length > 0) {
		throw new Error(`input validation failed:\n- ${collisionMessages.join('\n- ')}`);
	}

	const validationResults = await Promise.all(
		sources.map(async (source) => {
			try {
				const metadata = await readSourceMetadata(source.sourcePath);
				validateSourceMetadata(metadata);
				return { source, error: null };
			} catch (error) {
				return { source, error: error instanceof Error ? error.message : String(error) };
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

	return validationResults.map(({ source }) => source);
}

export async function runPipeline({
	inputDirectory = DEFAULT_INPUT_DIRECTORY,
	outputDirectory = OUTPUT_DIRECTORY,
	force = false
} = {}) {
	const resolvedInputDirectory = path.resolve(inputDirectory);
	const resolvedOutputDirectory = path.resolve(outputDirectory);
	if (resolvedInputDirectory === DEFAULT_INPUT_DIRECTORY && !(await fileExists(resolvedInputDirectory))) {
		await mkdir(resolvedInputDirectory, { recursive: true });
	}
	const sources = await collectSources(resolvedInputDirectory);
	await mkdir(resolvedOutputDirectory, { recursive: true });

	const summary = {
		scanned: sources.length,
		generated: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		outputDirectory: resolvedOutputDirectory,
		errors: []
	};

	for (const source of sources) {
		const outputPath = path.join(resolvedOutputDirectory, `${source.basename}.webp`);
		const outputExists = await fileExists(outputPath);
		const hadOutputBeforeConversion = outputExists;
		let shouldConvert = force || !outputExists;

		if (outputExists && !force) {
			const [sourceStats, outputStats] = await Promise.all([stat(source.sourcePath), stat(outputPath)]);
			const outputIsValid = await validateDeliveryImage(outputPath);
			shouldConvert = sourceStats.mtimeMs > outputStats.mtimeMs || !outputIsValid;
		}

		if (!shouldConvert) {
			summary.skipped += 1;
			continue;
		}

		try {
			await convertOne(source.sourcePath, outputPath);
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
