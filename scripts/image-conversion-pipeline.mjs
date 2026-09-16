import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export function createPipelineSignature(config) { return createHash('sha256').update(JSON.stringify(config)).digest('hex'); }
function describePath(root, filePath) { const relative = path.relative(root, filePath); return relative && !relative.startsWith('..') ? relative : filePath; }
async function metadata(filePath) { try { return await sharp(await readFile(filePath)).metadata(); } catch (error) { throw new Error(`cannot decode image (${error instanceof Error ? error.message : String(error)})`); } }
async function hash(filePath) { return createHash('sha256').update(await readFile(filePath)).digest('hex'); }
async function exists(filePath) { try { await access(filePath, fsConstants.F_OK); return true; } catch { return false; } }
async function replace(temp, target) { try { await rename(temp, target); } catch (error) { if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error; await rm(target, { force: true }); await rename(temp, target); } }
async function loadCache(filePath) { try { const parsed = JSON.parse(await readFile(filePath, 'utf8')); if (parsed?.version === 1 && parsed.entries && !Array.isArray(parsed.entries) && typeof parsed.entries === 'object') return parsed; } catch {} return { version: 1, entries: {} }; }
async function saveCache(filePath, entries) { const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`; try { await mkdir(path.dirname(filePath), { recursive: true }); await writeFile(temp, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8'); await replace(temp, filePath); } finally { await rm(temp, { force: true }); } }
async function validOutput(filePath, config, width = config.width, height = config.height) { try { const result = await sharp(await readFile(filePath)).metadata(); return result.format?.toLowerCase() === config.format && result.width === width && result.height === height; } catch { return false; } }

async function collectSources(inputDirectory, root, config) {
	let entries;
	try { entries = await readdir(inputDirectory, { withFileTypes: true }); } catch (error) { throw new Error(`cannot read input directory ${describePath(root, inputDirectory)} (${error instanceof Error ? error.message : String(error)})`); }
	const sources = entries.filter((entry) => entry.isFile()).map((entry) => ({ basename: path.parse(entry.name).name, sourcePath: path.join(inputDirectory, entry.name) })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
	const collisions = new Map();
	for (const source of sources) { const key = source.basename.toLowerCase(); const collision = collisions.get(key) ?? { basename: source.basename, paths: [] }; collision.paths.push(source.sourcePath); collisions.set(key, collision); }
	const collisionMessages = [...collisions.values()].filter((item) => item.paths.length > 1).map((item) => `basename "${item.basename}" maps to multiple outputs: ${item.paths.map((filePath) => describePath(root, filePath)).join(', ')}`);
	if (collisionMessages.length) throw new Error(`input validation failed:\n- ${collisionMessages.join('\n- ')}`);
	const results = await Promise.all(sources.map(async (source) => { try { const sourceMetadata = await metadata(source.sourcePath); return { source: { ...source, metadata: sourceMetadata }, warnings: config.validateSourceMetadata(sourceMetadata), error: null }; } catch (error) { return { source, warnings: [], error: error instanceof Error ? error.message : String(error) }; } }));
	const invalid = results.filter((result) => result.error !== null);
	if (invalid.length) throw new Error(`input validation failed:\n${invalid.map(({ source, error }) => `- ${describePath(root, source.sourcePath)}: ${error}`).join('\n')}`);
	return { sources: results.map(({ source }) => source), warnings: results.flatMap(({ source, warnings }) => warnings.map((warning) => `${describePath(root, source.sourcePath)}: ${warning}`)) };
}

async function convert(sourcePath, outputPath, sourceMetadata, config) {
	const temp = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		let image = sharp(sourcePath);
		if (config.trim) image = image.ensureAlpha().trim();
		const shouldResize = config.trim || !config.preserveSmallSources || sourceMetadata.width > config.width || sourceMetadata.height > config.height;
		if (shouldResize) image = image.resize({ width: config.width, height: config.height, fit: config.fit, position: config.position, ...(sourceMetadata.hasAlpha === true ? { background: config.background } : {}), withoutEnlargement: config.withoutEnlargement });
		await image.webp(config.webp).toFile(temp);
		const expectedWidth = shouldResize ? config.width : sourceMetadata.width;
		const expectedHeight = shouldResize ? config.height : sourceMetadata.height;
		if (!(await validOutput(temp, config, expectedWidth, expectedHeight))) throw new Error('generated output failed WebP or expected dimensions validation');
		await replace(temp, outputPath);
	} finally { await rm(temp, { force: true }); }
}

export function createImagePipeline({ repositoryRoot, defaultInputDirectory, outputDirectory, cachePath, config, signatureConfig = config }) {
	const pipelineSignature = createPipelineSignature(signatureConfig);
	return { pipelineSignature, async run({ inputDirectory = defaultInputDirectory, outputDirectory: requestedOutputDirectory = outputDirectory, cachePath: requestedCachePath = cachePath, force = false } = {}) {
		const resolvedInput = path.resolve(inputDirectory); const resolvedOutput = path.resolve(requestedOutputDirectory); const resolvedCache = path.resolve(requestedCachePath);
		if (resolvedInput === defaultInputDirectory && !(await exists(resolvedInput))) await mkdir(resolvedInput, { recursive: true });
		const { sources, warnings } = await collectSources(resolvedInput, repositoryRoot, config); await mkdir(resolvedOutput, { recursive: true });
		const withHashes = await Promise.all(sources.map(async (source) => ({ ...source, sourceHash: await hash(source.sourcePath) }))); const cache = await loadCache(resolvedCache); const entries = { ...cache.entries }; let cacheChanged = false;
		const summary = { scanned: sources.length, generated: 0, updated: 0, skipped: 0, failed: 0, outputDirectory: resolvedOutput, errors: [], warnings };
		for (const source of withHashes) {
			const outputPath = path.join(resolvedOutput, `${source.basename}.webp`); const hadOutput = await exists(outputPath); let skip = false; const cached = entries[source.basename];
			const expectedWidth = config.preserveSmallSources && source.metadata.width <= config.width && source.metadata.height <= config.height ? source.metadata.width : config.width;
			const expectedHeight = config.preserveSmallSources && source.metadata.width <= config.width && source.metadata.height <= config.height ? source.metadata.height : config.height;
			if (!force && hadOutput && await validOutput(outputPath, config, expectedWidth, expectedHeight) && cached?.pipelineSignature === pipelineSignature && cached.sourceSha256 === source.sourceHash) skip = cached.outputSha256 === await hash(outputPath);
			if (skip) { summary.skipped += 1; continue; }
			try { await convert(source.sourcePath, outputPath, source.metadata, config); entries[source.basename] = { sourceSha256: source.sourceHash, outputSha256: await hash(outputPath), pipelineSignature }; cacheChanged = true; if (hadOutput) summary.updated += 1; else summary.generated += 1; }
			catch (error) { summary.failed += 1; summary.errors.push(`${describePath(repositoryRoot, source.sourcePath)}: ${error instanceof Error ? error.message : String(error)}`); }
		}
		if (cacheChanged) { try { await saveCache(resolvedCache, entries); } catch (error) { summary.failed += 1; summary.errors.push(`cache ${resolvedCache}: ${error instanceof Error ? error.message : String(error)}`); } }
		return summary;
	} };
}

export function parseCliArguments(argumentsList) { let inputDirectory; let force = false; for (const argument of argumentsList) { if (argument === '--force') { force = true; continue; } if (argument.startsWith('-')) throw new Error(`unknown option: ${argument}`); if (inputDirectory !== undefined) throw new Error('only one input directory may be specified'); inputDirectory = path.resolve(process.cwd(), argument); } return { inputDirectory, force }; }
