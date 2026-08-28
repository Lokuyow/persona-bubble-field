import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { parseCliArguments, PIPELINE_SIGNATURE, runPipeline } from './convert-character-images.mjs';

const temporaryDirectories = [];

async function createTemporaryDirectory() {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'persona-character-images-'));
	temporaryDirectories.push(directory);
	return directory;
}

async function createFixture(
	filePath,
	{ width = 1024, height = 768, channels = 4, format = 'png', background = { r: 40, g: 120, b: 220, alpha: 1 } } = {}
) {
	const image = await sharp({
		create: {
			width,
			height,
			channels,
			background: channels === 4 ? background : { r: background.r, g: background.g, b: background.b }
		}
	})[format]().toBuffer();
	await writeFile(filePath, image);
}

function getPipelineOptions(root) {
	return {
		inputDirectory: path.join(root, 'sources'),
		outputDirectory: path.join(root, 'output'),
		cachePath: path.join(root, '.character-image-cache.json')
	};
}

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		await rm(temporaryDirectories.pop(), { recursive: true, force: true });
	}
});

describe('character image conversion pipeline', () => {
	it('generates a contained 512x512 alpha WebP and preserves the source basename', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'stone_001.png'));

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const outputPath = path.join(outputDirectory, 'stone_001.webp');
		const outputBuffer = await readFile(outputPath);
		const cache = JSON.parse(await readFile(cachePath, 'utf8'));
		const metadata = await sharp(outputBuffer).metadata();
		const { data, info } = await sharp(outputBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

		expect(summary).toMatchObject({ scanned: 1, generated: 1, updated: 0, skipped: 0, failed: 0 });
		expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512, hasAlpha: true });
		expect(cache.entries.stone_001).toMatchObject({
			sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
			pipelineSignature: PIPELINE_SIGNATURE
		});
		expect(info.channels).toBe(4);
		expect(data[3]).toBe(0);
		expect(data[(64 * info.width + 256) * info.channels + 3]).toBe(255);
		expect(data[(448 * info.width + 256) * info.channels + 3]).toBe(0);
	});

	it.each([
		['WebP source files are not accepted', { format: 'webp' }],
		['source dimensions must both be greater than 512px', { width: 512 }],
		['source image must have an alpha channel', { channels: 3 }]
	])('rejects invalid source files: %s', async (expectedMessage, fixtureOptions) => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'invalid.png'), fixtureOptions);

		await expect(runPipeline({ inputDirectory, outputDirectory, cachePath })).rejects.toThrow(expectedMessage);
	});

	it('rejects duplicate basenames instead of choosing one source', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'stone.png'));
		await createFixture(path.join(inputDirectory, 'stone.jpg'), { format: 'jpeg' });

		await expect(runPipeline({ inputDirectory, outputDirectory, cachePath })).rejects.toThrow(
			'basename "stone" maps to multiple outputs'
		);
	});

	it('skips unchanged content after initial generation', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		const sourcePath = path.join(inputDirectory, 'stone.png');
		await createFixture(sourcePath);
		const first = await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const second = await runPipeline({ inputDirectory, outputDirectory, cachePath });

		expect(first).toMatchObject({ generated: 1, updated: 0, skipped: 0 });
		expect(second).toMatchObject({ generated: 0, updated: 0, skipped: 1 });
	});

	it('updates when source content changes even if the source mtime is older than the output', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		const sourcePath = path.join(inputDirectory, 'stone.png');
		await createFixture(sourcePath);
		await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const outputStats = await stat(path.join(outputDirectory, 'stone.webp'));
		await createFixture(sourcePath, { background: { r: 200, g: 80, b: 40, alpha: 1 } });
		await utimes(sourcePath, new Date(outputStats.mtimeMs - 1000), new Date(outputStats.mtimeMs - 1000));

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });

		expect(summary).toMatchObject({ generated: 0, updated: 1, skipped: 0 });
	});

	it('updates when a valid existing output has been replaced', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		const sourcePath = path.join(inputDirectory, 'stone.png');
		await createFixture(sourcePath);
		await runPipeline({ inputDirectory, outputDirectory, cachePath });
		await createFixture(path.join(outputDirectory, 'stone.webp'), { width: 512, height: 512, format: 'webp' });

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });

		expect(summary).toMatchObject({ generated: 0, updated: 1, skipped: 0 });
	});

	it('regenerates a valid existing output when the cache is missing', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'stone.png'));
		await runPipeline({ inputDirectory, outputDirectory, cachePath });
		await rm(cachePath);

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });

		expect(summary).toMatchObject({ generated: 0, updated: 1, skipped: 0 });
		expect(JSON.parse(await readFile(cachePath, 'utf8')).entries.stone).toBeDefined();
	});

	it('force regenerates a hash-matching output and updates the cache', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'stone.png'));
		await runPipeline({ inputDirectory, outputDirectory, cachePath });

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath, force: true });

		expect(summary).toMatchObject({ generated: 0, updated: 1, skipped: 0 });
	});

	it('rejects case-insensitive basename collisions before conversion', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'Stone.png'));
		await createFixture(path.join(inputDirectory, 'stone.tiff'), { format: 'tiff' });

		await expect(runPipeline({ inputDirectory, outputDirectory, cachePath })).rejects.toThrow(
			'basename "Stone" maps to multiple outputs'
		);
	});

	it('regenerates invalid existing output and does not delete unrelated delivery images', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		const sourcePath = path.join(inputDirectory, 'stone.png');
		await createFixture(sourcePath);
		await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const unrelatedOutput = path.join(outputDirectory, 'unrelated.webp');
		await createFixture(unrelatedOutput, { format: 'webp' });
		await writeFile(path.join(outputDirectory, 'stone.webp'), Buffer.from('not an image'));

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const metadata = await sharp(await readFile(path.join(outputDirectory, 'stone.webp'))).metadata();

		expect(summary).toMatchObject({ generated: 0, updated: 1, skipped: 0 });
		expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512, hasAlpha: true });
		expect(await sharp(await readFile(unrelatedOutput)).metadata()).toMatchObject({ format: 'webp' });
	});

	it('reports aggregate generated, updated, and skipped counts', async () => {
		const root = await createTemporaryDirectory();
		const { inputDirectory, outputDirectory, cachePath } = getPipelineOptions(root);
		await mkdir(inputDirectory);
		await createFixture(path.join(inputDirectory, 'one.png'));
		await createFixture(path.join(inputDirectory, 'two.png'));
		await runPipeline({ inputDirectory, outputDirectory, cachePath });
		const outputStats = await stat(path.join(outputDirectory, 'one.webp'));
		await createFixture(path.join(inputDirectory, 'one.png'), { background: { r: 200, g: 80, b: 40, alpha: 1 } });
		await utimes(path.join(inputDirectory, 'one.png'), new Date(outputStats.mtimeMs + 1000), new Date(outputStats.mtimeMs + 1000));
		await createFixture(path.join(inputDirectory, 'three.png'));

		const summary = await runPipeline({ inputDirectory, outputDirectory, cachePath });

		expect(summary).toMatchObject({ scanned: 3, generated: 1, updated: 1, skipped: 1, failed: 0 });
	});

	it('parses an optional input directory and --force in either order', () => {
		expect(parseCliArguments(['D:/character originals', '--force'])).toMatchObject({
			inputDirectory: path.resolve(process.cwd(), 'D:/character originals'),
			force: true
		});
		expect(parseCliArguments(['--force'])).toMatchObject({ force: true });
	});
});
