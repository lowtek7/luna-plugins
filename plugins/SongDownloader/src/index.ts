import { Tracer, type LunaUnload } from "@luna/core";
import { ContextMenu, safeInterval, StyleTag } from "@luna/lib";

import { getDownloadFolder, getDownloadPath, getFileName } from "./helpers";
import { settings } from "./Settings";

import styles from "file://downloadButton.css?minify";

export const { errSignal, trace } = Tracer("[SongDownloader]");
export const unloads = new Set<LunaUnload>();

new StyleTag("SongDownloader", unloads, styles);

const downloadButton = ContextMenu.addButton(unloads);

export { Settings } from "./Settings";

/** DEFECT 6: 재시도 불가능한 에러인지 판별한다. (404, 인증 실패 등) */
const isNonRetryableError = (err: unknown): boolean => {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (msg.includes("404") || msg.includes("not found")) return true;
		if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) return true;
	}
	return false;
};

/** DEFECT 6: 지수 백오프 재시도와 함께 다운로드를 수행한다. */
const MaxRetryAttempts = 3;
const RetryDelaysMs = [2000, 5000, 10000] as const;

const downloadWithRetry = async (
	mediaItem: { download: (path: string | string[], quality?: unknown) => Promise<void>; downloadProgress: () => Promise<{ total?: number; downloaded?: number } | undefined> },
	path: string | string[],
	quality: unknown,
	trackTitle: string,
): Promise<boolean> => {
	for (let attempt = 0; attempt < MaxRetryAttempts; attempt++) {
		try {
			await mediaItem.download(path, quality);
			return true;
		} catch (err) {
			if (isNonRetryableError(err)) {
				trace.msg.err.withContext(`Non-retryable error for "${trackTitle}", skipping.`)(err);
				return false;
			}
			const isLastAttempt = attempt >= MaxRetryAttempts - 1;
			if (isLastAttempt) {
				trace.msg.err.withContext(`Failed to download "${trackTitle}" after ${MaxRetryAttempts} attempts.`)(err);
				return false;
			}
			const delayMs = RetryDelaysMs[attempt]!;
			const delaySec = delayMs / 1000;
			trace.msg.err.withContext(`Download attempt ${attempt + 1}/${MaxRetryAttempts} failed for "${trackTitle}", retrying in ${delaySec}s...`)(err);

			// 카운트다운 UI 표시
			const countdownIntervalMs = 1000;
			let remainingSec = delaySec;
			while (remainingSec > 0) {
				if (downloadButton.elem === undefined) return false;
				downloadButton.text = `Retrying in ${remainingSec}s... (${attempt + 2}/${MaxRetryAttempts})`;
				await new Promise((r) => setTimeout(r, countdownIntervalMs));
				remainingSec--;
			}
		}
	}
	return false;
};

/** DEFECT 7 & 6(c): native fs API를 사용하여 파일 존재 여부와 크기를 확인한다. */
const checkFileExists = async (filePath: string): Promise<{ exists: boolean; size?: number }> => {
	try {
		const fs = await import("fs/promises");
		const stat = await fs.stat(filePath);
		return { exists: true, size: stat.size };
	} catch {
		return { exists: false };
	}
};

/** DEFECT 6(c): 부분 다운로드된 파일을 삭제한다. */
const deleteFile = async (filePath: string): Promise<void> => {
	try {
		const fs = await import("fs/promises");
		await fs.unlink(filePath);
	} catch {
		// 파일이 없으면 무시
	}
};

/** 다운로드 경로를 단일 문자열로 변환한다. */
const pathToString = (path: string | string[]): string => {
	if (Array.isArray(path)) return path.join("/");
	return path;
};

/** DEFECT 1: 다운로드 진행 중 재진입을 방지하는 플래그 */
let isDownloading = false;

ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
	const trackCount = await mediaCollection.count();
	if (trackCount === 0) return;

	const defaultText = (downloadButton.text = `Download ${trackCount} tracks`);

	downloadButton.onClick(async () => {
		// DEFECT 1: 이미 다운로드 중이면 무시한다
		if (isDownloading) return;
		if (downloadButton.elem === undefined) return;

		isDownloading = true;
		try {
			const downloadFolder = settings.defaultPath ?? (trackCount > 1 ? await getDownloadFolder() : undefined);

			// DEFECT 5: elem이 사라졌으면 중단
			if (downloadButton.elem === undefined) return;
			downloadButton.elem.classList.add("download-button");

			// DEFECT 7: 모든 트랙의 경로를 사전 계산하여 이미 존재하는 파일을 필터링한다
			downloadButton.text = "Preparing download list...";

			type TrackInfo = {
				mediaItem: Awaited<ReturnType<Awaited<ReturnType<typeof mediaCollection.mediaItems>>["next"]>>["value"];
				tags: Record<string, string | string[] | undefined>;
				fileName: string;
				path: string | string[] | undefined;
				title: string;
			};

			const tracksToProcess: TrackInfo[] = [];
			let skippedCount = 0;

			for await (let mediaItem of await mediaCollection.mediaItems()) {
				// DEFECT 5: elem 마운트 해제 체크
				if (downloadButton.elem === undefined) return;

				if (settings.useRealMAX) {
					downloadButton.text = "Checking RealMax...";
					mediaItem = (await mediaItem.max()) ?? mediaItem;
				}

				downloadButton.text = "Loading tags...";
				const { tags } = await mediaItem.flacTags();

				// DEFECT 3: tags를 getFileName에 직접 전달
				downloadButton.text = "Fetching filename...";
				const fileName = await getFileName(mediaItem, settings.downloadQuality, tags);

				downloadButton.text = "Fetching download path...";
				const path = downloadFolder !== undefined ? [downloadFolder, fileName] : await getDownloadPath(fileName);

				// DEFECT 4: return 대신 continue — 사용자가 경로 선택을 취소한 경우
				if (path === undefined) continue;

				// DEFECT 7: 파일 존재 여부 확인
				const fullPath = pathToString(path);
				const fileCheck = await checkFileExists(fullPath);
				if (fileCheck.exists) {
					// 크기를 알 수 없거나 정상 크기이면 건너뛴다
					// 크기가 0이거나 비정상적으로 작으면 (부분 다운로드) 삭제 후 재다운로드
					const MinValidFileSizeBytes = 1024;
					if (fileCheck.size !== undefined && fileCheck.size >= MinValidFileSizeBytes) {
						skippedCount++;
						continue;
					}
					// 부분 다운로드 파일 삭제
					await deleteFile(fullPath);
				}

				const title = typeof tags.title === "string" ? tags.title : (Array.isArray(tags.title) ? tags.title[0] : fileName) ?? fileName;

				tracksToProcess.push({ mediaItem, tags, fileName, path, title });
			}

			const totalToDownload = tracksToProcess.length;

			if (totalToDownload === 0) {
				if (downloadButton.elem !== undefined) {
					downloadButton.text = skippedCount > 0 ? `All ${skippedCount} tracks already exist` : "No tracks to download";
					await new Promise((r) => setTimeout(r, 2000));
				}
			} else {
				// DEFECT 7(d): 필터링된 수를 UI에 반영
				const skippedSuffix = skippedCount > 0 ? ` (${skippedCount} already exist)` : "";

				for (let i = 0; i < totalToDownload; i++) {
					const { mediaItem, path, title } = tracksToProcess[i]!;

					// DEFECT 5: 루프 시작마다 elem 체크
					if (downloadButton.elem === undefined) break;

					downloadButton.text = `Downloading ${i}/${totalToDownload}${skippedSuffix}`;

					// DEFECT 2: 비동기 interval 콜백 누적 방지
					// 공유 상태 객체를 사용하여 interval은 동기적으로만 읽는다
					const progressState = { total: 0, downloaded: 0, hasData: false };
					let progressPollActive = true;

					// 별도 비동기 루프로 진행 상태를 폴링한다
					const progressPoller = (async () => {
						while (progressPollActive) {
							try {
								const progress = await mediaItem.downloadProgress();
								if (progress !== undefined) {
									const { total, downloaded } = progress;
									if (total !== undefined && downloaded !== undefined) {
										progressState.total = total;
										progressState.downloaded = downloaded;
										progressState.hasData = true;
									}
								}
							} catch {
								// 진행 상태 조회 실패는 무시
							}
							if (!progressPollActive) break;
							await new Promise((r) => setTimeout(r, 200));
						}
					})();

					// 동기 interval로 UI만 갱신한다
					const clearProgressInterval = safeInterval(
						unloads,
						() => {
							// DEFECT 5: elem 마운트 해제 체크
							if (downloadButton.elem === undefined) return;
							if (!progressState.hasData) return;

							const { total, downloaded } = progressState;
							const percent = total > 0 ? (downloaded / total) * 100 : 0;
							downloadButton.elem.style.setProperty("--progress", `${percent}%`);
							const downloadedMB = (downloaded / 1048576).toFixed(0);
							const totalMB = (total / 1048576).toFixed(0);
							downloadButton.text = `Downloading ${i + 1}/${totalToDownload} — ${downloadedMB}/${totalMB}MB ${percent.toFixed(0)}%`;
						},
						50,
					);

					// DEFECT 6: 재시도 로직으로 다운로드
					const success = await downloadWithRetry(mediaItem, path!, settings.downloadQuality, title);
					if (!success) {
						// DEFECT 6(c): 최종 실패 시 부분 파일 삭제
						await deleteFile(pathToString(path!));
					}

					// 진행 상태 폴링 정지 및 interval 정리
					progressPollActive = false;
					clearProgressInterval();
					await progressPoller;

					// 프로그레스 바 리셋
					if (downloadButton.elem !== undefined) {
						downloadButton.elem.style.setProperty("--progress", "0%");
					}
				}
			}

			// 루프 완료 후 UI 정리
			if (downloadButton.elem !== undefined) {
				downloadButton.text = defaultText;
				downloadButton.elem.classList.remove("download-button");
			}
		} finally {
			// DEFECT 1 & 4: 어떤 경로로 종료되든 플래그와 UI를 정리한다
			isDownloading = false;
			if (downloadButton.elem !== undefined) {
				downloadButton.elem.classList.remove("download-button");
				downloadButton.elem.style.setProperty("--progress", "0%");
			}
		}
	});

	await downloadButton.show(contextMenu);
});
