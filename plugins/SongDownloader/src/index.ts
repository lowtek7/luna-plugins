import { Tracer, type LunaUnload } from "@luna/core";
import { ContextMenu, StyleTag } from "@luna/lib";

import { getDownloadFolder } from "./helpers";
import { settings } from "./Settings";
import { DownloadQueue } from "./DownloadQueue";
import { mountPanel } from "./DownloadPanel";

import buttonStyles from "file://downloadButton.css?minify";
import panelStyles from "file://downloadPanel.css?minify";

export const { errSignal, trace } = Tracer("[SongDownloader]");
export const unloads = new Set<LunaUnload>();

// CSS 주입
new StyleTag("SongDownloader", unloads, buttonStyles + panelStyles);

// 다운로드 큐 초기화
const queue = new DownloadQueue();
unloads.add(() => queue.destroy());

// 다운로드 패널 마운트
mountPanel(queue, unloads);

// 컨텍스트 메뉴 버튼
const downloadButton = ContextMenu.addButton(unloads);

export { Settings } from "./Settings";

/** 큐에 트랙 추가 중 재진입 방지 */
let isAdding = false;

ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
	const trackCount = await mediaCollection.count();
	if (trackCount === 0) return;

	downloadButton.text = `Add ${trackCount} tracks to downloads`;

	downloadButton.onClick(async () => {
		if (isAdding) return;
		isAdding = true;

		try {
			// 다운로드 폴더 결정: 설정 우선, 없으면 다이얼로그
			const downloadFolder = settings.defaultPath ?? (await getDownloadFolder());
			if (!downloadFolder) return;

			downloadButton.text = "Adding to queue...";
			const added = await queue.addTracks(mediaCollection, downloadFolder);
			downloadButton.text = added > 0 ? `Added ${added} tracks ✓` : "All tracks already exist";
		} catch (err) {
			trace.msg.err.withContext("Failed to add tracks")(err);
			downloadButton.text = "Failed to add tracks";
		} finally {
			isAdding = false;
		}
	});

	await downloadButton.show(contextMenu);
});
