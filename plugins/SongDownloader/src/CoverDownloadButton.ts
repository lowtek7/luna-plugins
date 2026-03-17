import { Tracer } from "@luna/core";
import { ContextMenu, MediaItem, observe } from "@luna/lib";

import type { DownloadQueue } from "./DownloadQueue";
import { getDownloadFolder } from "./helpers";
import { settings } from "./Settings";

const { trace } = Tracer("[SongDownloader.CoverBtn]");

/** 커버 위에 다운로드 버튼이 이미 주입되었는지 확인하기 위한 마커 */
const InjectedMarker = "sd-cover-injected";

/** data-test 속성에서 mediaType과 ID를 추출한다. */
const parseCardDataTest = (value: string): { type: "album" | "playlist" | "mix"; id: string } | undefined => {
	const albumMatch = value.match(/^album-card-(.+)$/);
	if (albumMatch) return { type: "album", id: albumMatch[1]! };

	const playlistMatch = value.match(/^playlist-card-(.+)$/);
	if (playlistMatch) return { type: "playlist", id: playlistMatch[1]! };

	const mixMatch = value.match(/^mix-card-(.+)$/);
	if (mixMatch) return { type: "mix", id: mixMatch[1]! };

	return undefined;
};

/** 다운로드 버튼 요소를 생성한다. */
const createDownloadButton = (onClick: (e: MouseEvent) => void): HTMLButtonElement => {
	const btn = document.createElement("button");
	btn.className = "sd-cover-dl-btn";
	btn.title = "Download";
	btn.setAttribute("aria-label", "Download");
	btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
	btn.addEventListener("click", (e) => {
		e.stopPropagation();
		e.preventDefault();
		onClick(e);
	});
	return btn;
};

/** 카드 요소에 다운로드 버튼을 주입한다. */
const injectButton = (card: Element, queue: DownloadQueue): void => {
	if (card.hasAttribute(InjectedMarker)) return;
	card.setAttribute(InjectedMarker, "true");

	const dataTest = card.getAttribute("data-test");
	if (!dataTest) return;

	const parsed = parseCardDataTest(dataTest);
	if (!parsed) return;

	// 이미지 컨테이너(커버 영역)를 찾는다
	const imageContainer = card.querySelector<HTMLElement>('[class*="_imageContainer_"]');
	if (!imageContainer) return;

	// 이미지 컨테이너에 relative position 보장
	if (getComputedStyle(imageContainer).position === "static") {
		imageContainer.style.position = "relative";
	}

	const btn = createDownloadButton(async () => {
		// 다운로드 시각적 피드백
		btn.classList.add("sd-cover-dl-btn--loading");
		btn.innerHTML = `<svg class="sd-cover-dl-spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-dasharray="30 70" /></svg>`;

		try {
			const downloadFolder = settings.defaultPath ?? (await getDownloadFolder());
			if (!downloadFolder) {
				resetButton(btn);
				return;
			}

			// Luna의 ContextMenu API를 통해 mediaCollection을 가져온다
			const mediaCollection = await ContextMenu.mediaCollection(parsed.type, parsed.id);
			if (!mediaCollection) {
				trace.msg.err(`No media collection found for ${parsed.type}:${parsed.id}`);
				resetButton(btn);
				return;
			}

			const added = await queue.addTracks(mediaCollection, downloadFolder);

			// 완료 피드백
			btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
			btn.classList.remove("sd-cover-dl-btn--loading");
			btn.classList.add("sd-cover-dl-btn--done");

			setTimeout(() => resetButton(btn), 2000);
		} catch (err) {
			trace.msg.err.withContext(`Failed to download ${parsed.type}:${parsed.id}`)(err);
			btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
			btn.classList.remove("sd-cover-dl-btn--loading");
			btn.classList.add("sd-cover-dl-btn--error");
			setTimeout(() => resetButton(btn), 3000);
		}
	});

	imageContainer.appendChild(btn);
};

/** 버튼을 초기 상태로 되돌린다. */
const resetButton = (btn: HTMLButtonElement) => {
	btn.classList.remove("sd-cover-dl-btn--loading", "sd-cover-dl-btn--done", "sd-cover-dl-btn--error");
	btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
};

/** 커버 다운로드 버튼 기능을 초기화한다. */
export const initCoverButtons = (queue: DownloadQueue, unloads: Set<{ (): void }>) => {
	// observe로 새 카드가 DOM에 삽입될 때마다 버튼을 주입한다
	const cardSelector = 'div[data-test*="-card-"]';
	observe(unloads, cardSelector, (card: Element) => injectButton(card, queue));

	// 이미 페이지에 있는 카드들에도 주입
	document.querySelectorAll<HTMLElement>(cardSelector).forEach((card) => injectButton(card, queue));
};
