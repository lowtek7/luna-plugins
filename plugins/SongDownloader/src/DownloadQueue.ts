import { Tracer } from "@luna/core";
import type { MediaItem } from "@luna/lib";

import { getFileName } from "./helpers";
import { settings } from "./Settings";

const { trace } = Tracer("[SongDownloader.Queue]");

// --- 타입 ---

export type TrackStatus = "queued" | "downloading" | "completed" | "failed" | "skipped";

export interface DownloadTrack {
	id: string;
	title: string;
	artist: string;
	album: string;
	coverUrl?: string;
	fileName: string;
	path: string | string[];
	status: TrackStatus;
	progress: number;
	downloadedBytes: number;
	totalBytes: number;
	error?: string;
	retryCount: number;
	/** @internal 다운로드/재시도에 필요한 MediaItem 참조 */
	_mediaItem: MediaItem;
}

// --- 상수 ---

const MaxRetryAttempts = 3;
const RetryDelaysMs = [2000, 5000, 10000] as const;
const MinValidFileSizeBytes = 1024;
const ProgressPollMs = 300;

// --- 유틸리티 ---

const isNonRetryable = (err: unknown): boolean => {
	if (!(err instanceof Error)) return false;
	const m = err.message.toLowerCase();
	return m.includes("404") || m.includes("not found") || m.includes("401") || m.includes("403") || m.includes("unauthorized") || m.includes("forbidden");
};

const fileExists = async (p: string): Promise<{ exists: boolean; size?: number }> => {
	try {
		const fs = await import("fs/promises");
		const s = await fs.stat(p);
		return { exists: true, size: s.size };
	} catch {
		return { exists: false };
	}
};

const deleteFile = async (p: string) => {
	try {
		const fs = await import("fs/promises");
		await fs.unlink(p);
	} catch {
		/* 무시 */
	}
};

export const pathStr = (p: string | string[]): string => (Array.isArray(p) ? p.join("/") : p);

const extractTag = (v: string | string[] | undefined): string => {
	if (Array.isArray(v)) return v[0] ?? "Unknown";
	return v ?? "Unknown";
};

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- 큐 매니저 ---

type Subscriber = () => void;

export class DownloadQueue {
	private _items: DownloadTrack[] = [];
	private _subs = new Set<Subscriber>();
	private _processing = false;
	private _paused = false;
	private _destroyed = false;

	get items(): readonly DownloadTrack[] {
		return this._items;
	}
	get isPaused() {
		return this._paused;
	}
	get isProcessing() {
		return this._processing;
	}

	subscribe(fn: Subscriber) {
		this._subs.add(fn);
		return () => {
			this._subs.delete(fn);
		};
	}

	private notify() {
		for (const fn of this._subs) fn();
	}

	private update(id: string, patch: Partial<DownloadTrack>) {
		const t = this._items.find((i) => i.id === id);
		if (t) Object.assign(t, patch);
		this.notify();
	}

	/** mediaCollection의 모든 트랙을 큐에 추가한다. */
	async addTracks(mediaCollection: { mediaItems: () => Promise<AsyncIterable<MediaItem>>; count: () => Promise<number> }, downloadFolder: string): Promise<number> {
		let added = 0;
		let skipped = 0;

		for await (let mediaItem of await mediaCollection.mediaItems()) {
			if (this._destroyed) break;

			if (settings.useRealMAX) {
				mediaItem = (await mediaItem.max?.()) ?? mediaItem;
			}

			const { tags } = await mediaItem.flacTags();
			const fileName = await getFileName(mediaItem, settings.downloadQuality, tags);
			const path = [downloadFolder, fileName];

			// 파일 존재 여부 확인
			const full = pathStr(path);
			const check = await fileExists(full);
			if (check.exists && check.size !== undefined && check.size >= MinValidFileSizeBytes) {
				skipped++;
				continue;
			}
			if (check.exists) await deleteFile(full);

			// 중복 체크: 같은 경로의 트랙이 이미 큐에 있으면 건너뛴다
			if (this._items.some((i) => pathStr(i.path) === full && i.status !== "failed")) {
				skipped++;
				continue;
			}

			const coverUrl = await mediaItem.coverUrl?.({ res: "80" }).catch(() => undefined);

			this._items.push({
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				title: extractTag(tags.title),
				artist: extractTag(tags.artist),
				album: extractTag(tags.album),
				coverUrl,
				fileName,
				path,
				status: "queued",
				progress: 0,
				downloadedBytes: 0,
				totalBytes: 0,
				retryCount: 0,
				_mediaItem: mediaItem,
			});
			added++;
			this.notify();
		}

		if (added > 0) this.processNext();
		trace.log(`Added ${added} tracks, skipped ${skipped}`);
		return added;
	}

	// --- 다운로드 루프 ---

	private async processNext(): Promise<void> {
		if (this._processing || this._destroyed) return;
		this._processing = true;
		this.notify();

		while (!this._destroyed) {
			if (this._paused) {
				await delay(500);
				continue;
			}
			const next = this._items.find((i) => i.status === "queued");
			if (!next) break;
			await this.downloadTrack(next);
		}

		this._processing = false;
		this.notify();
	}

	private async downloadTrack(track: DownloadTrack): Promise<void> {
		this.update(track.id, { status: "downloading", progress: 0, downloadedBytes: 0, totalBytes: 0, error: undefined });

		// 진행률 폴링
		let pollActive = true;
		const poller = (async () => {
			while (pollActive && !this._destroyed) {
				try {
					const p = await track._mediaItem.downloadProgress?.();
					if (p?.total !== undefined && p?.downloaded !== undefined) {
						const progress = p.total > 0 ? (p.downloaded / p.total) * 100 : 0;
						this.update(track.id, { progress, downloadedBytes: p.downloaded, totalBytes: p.total });
					}
				} catch {
					/* 무시 */
				}
				if (!pollActive) break;
				await delay(ProgressPollMs);
			}
		})();

		let success = false;
		for (let attempt = 0; attempt < MaxRetryAttempts; attempt++) {
			try {
				await track._mediaItem.download(track.path, settings.downloadQuality);
				success = true;
				break;
			} catch (err) {
				if (isNonRetryable(err)) {
					trace.msg.err.withContext(`Non-retryable: "${track.title}"`)(err);
					break;
				}
				if (attempt >= MaxRetryAttempts - 1) {
					trace.msg.err.withContext(`Failed after ${MaxRetryAttempts} attempts: "${track.title}"`)(err);
					break;
				}
				const delaySec = RetryDelaysMs[attempt]! / 1000;
				trace.msg.err.withContext(`Attempt ${attempt + 1} failed for "${track.title}", retrying in ${delaySec}s`)(err);
				this.update(track.id, { error: `Retrying in ${delaySec}s... (${attempt + 2}/${MaxRetryAttempts})` });
				await delay(RetryDelaysMs[attempt]!);
				track.retryCount++;
			}
		}

		pollActive = false;
		await poller;

		if (success) {
			this.update(track.id, { status: "completed", progress: 100 });
		} else {
			await deleteFile(pathStr(track.path));
			this.update(track.id, { status: "failed", error: track.error || "Download failed" });
		}
	}

	// --- 액션 ---

	retryTrack(id: string) {
		this.update(id, { status: "queued", progress: 0, error: undefined, downloadedBytes: 0, totalBytes: 0 });
		if (!this._processing) this.processNext();
	}

	retryAllFailed() {
		for (const t of this._items) {
			if (t.status === "failed") Object.assign(t, { status: "queued", progress: 0, error: undefined, downloadedBytes: 0, totalBytes: 0 });
		}
		this.notify();
		if (!this._processing) this.processNext();
	}

	removeTrack(id: string) {
		this._items = this._items.filter((i) => i.id !== id);
		this.notify();
	}

	clearCompleted() {
		this._items = this._items.filter((i) => i.status !== "completed" && i.status !== "skipped");
		this.notify();
	}

	clearAll() {
		this._items = this._items.filter((i) => i.status === "downloading");
		this.notify();
	}

	togglePause() {
		this._paused = !this._paused;
		this.notify();
	}

	destroy() {
		this._destroyed = true;
		this._items = [];
		this._subs.clear();
	}
}
