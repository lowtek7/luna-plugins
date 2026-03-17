import React from "react";
import type { DownloadQueue, DownloadTrack, TrackStatus } from "./DownloadQueue";

// --- 상태 헬퍼 ---

const statusIcon: Record<TrackStatus, string> = {
	queued: "⏳",
	downloading: "",
	completed: "✓",
	failed: "✕",
	skipped: "—",
};

const statusLabel = (t: DownloadTrack): string => {
	switch (t.status) {
		case "queued":
			return "Queued";
		case "downloading": {
			if (t.totalBytes > 0) {
				const dlMB = (t.downloadedBytes / 1048576).toFixed(1);
				const totMB = (t.totalBytes / 1048576).toFixed(1);
				return `${t.progress.toFixed(0)}% · ${dlMB}/${totMB}MB`;
			}
			return t.error ?? "Downloading...";
		}
		case "completed":
			return "Done";
		case "failed":
			return "↻ Retry";
		case "skipped":
			return "Skipped";
	}
};

// --- TrackItem ---

const TrackItem = ({ track, queue }: { track: DownloadTrack; queue: DownloadQueue }) => {
	const isActive = track.status === "downloading";
	const isFailed = track.status === "failed";
	const isDone = track.status === "completed";

	return (
		<div className={`sd-track${isDone ? " sd-track--completed" : ""}`}>
			{/* 커버 아트 */}
			{track.coverUrl ? (
				<img className="sd-track-cover" src={track.coverUrl} alt="" loading="lazy" />
			) : (
				<div className="sd-track-cover-placeholder">♫</div>
			)}

			{/* 트랙 정보 */}
			<div className="sd-track-info">
				<div className="sd-track-title">{track.title}</div>
				<div className="sd-track-sub">
					{track.artist} · {track.album}
				</div>
				{isActive && (
					<div className="sd-progress-wrap">
						<div className="sd-progress-bar" style={{ width: `${track.progress}%` }} />
					</div>
				)}
				{isFailed && track.error && (
					<div className="sd-progress-wrap">
						<div className="sd-progress-bar sd-progress-bar--failed" style={{ width: "100%" }} />
					</div>
				)}
			</div>

			{/* 상태 */}
			<span
				className={`sd-track-status sd-status--${track.status}`}
				onClick={isFailed ? () => queue.retryTrack(track.id) : undefined}
			>
				{isActive ? <span className="sd-spinner" /> : statusIcon[track.status]}{" "}
				{statusLabel(track)}
			</span>

			{/* 삭제 버튼 (다운로드 중이 아닌 경우만) */}
			{!isActive && (
				<button className="sd-track-remove" onClick={() => queue.removeTrack(track.id)} title="Remove">
					×
				</button>
			)}
		</div>
	);
};

// --- PanelRoot ---

const PanelRoot = ({ queue }: { queue: DownloadQueue }) => {
	const [items, setItems] = React.useState<DownloadTrack[]>([]);
	const [isOpen, setIsOpen] = React.useState(false);
	const [isPaused, setIsPaused] = React.useState(false);

	React.useEffect(() => {
		return queue.subscribe(() => {
			setItems([...queue.items]);
			setIsPaused(queue.isPaused);
		});
	}, []);

	// 트랙이 처음 추가되면 자동으로 패널 열기
	const prevLen = React.useRef(0);
	React.useEffect(() => {
		if (items.length > 0 && prevLen.current === 0) setIsOpen(true);
		prevLen.current = items.length;
	}, [items.length]);

	if (items.length === 0) return null;

	const active = items.filter((i) => i.status === "downloading" || i.status === "queued").length;
	const completed = items.filter((i) => i.status === "completed").length;
	const failed = items.filter((i) => i.status === "failed").length;
	const total = items.length;

	return (
		<>
			{/* FAB */}
			<div
				className={`sd-fab${active > 0 ? " sd-fab--active" : ""}`}
				onClick={() => setIsOpen(!isOpen)}
			>
				<span className="sd-fab-icon">⬇</span>
				{active > 0 && <span className="sd-fab-badge">{active}</span>}
			</div>

			{/* Panel */}
			{isOpen && (
				<div className="sd-panel">
					{/* Header */}
					<div className="sd-header">
						<div className="sd-header-title">
							<span className="sd-header-title-icon">⬇</span>
							Downloads
						</div>
						<div className="sd-header-actions">
							<button className="sd-header-btn" onClick={() => setIsOpen(false)} title="Minimize">
								─
							</button>
							<button
								className="sd-header-btn"
								onClick={() => {
									queue.clearAll();
									setIsOpen(false);
								}}
								title="Close"
							>
								×
							</button>
						</div>
					</div>

					{/* Track List */}
					<div className="sd-list">
						{items.length === 0 ? (
							<div className="sd-empty">No downloads yet</div>
						) : (
							items.map((track) => <TrackItem key={track.id} track={track} queue={queue} />)
						)}
					</div>

					{/* Footer */}
					<div className="sd-footer">
						<div className="sd-footer-summary">
							{completed}/{total} completed
							{failed > 0 && ` · ${failed} failed`}
							{isPaused && " · Paused"}
						</div>
						<div className="sd-footer-actions">
							<button
								className={`sd-action-btn${isPaused ? " sd-action-btn--primary" : ""}`}
								onClick={() => queue.togglePause()}
							>
								{isPaused ? "▶ Resume" : "⏸ Pause"}
							</button>
							{failed > 0 && (
								<button className="sd-action-btn sd-action-btn--primary" onClick={() => queue.retryAllFailed()}>
									↻ Retry All
								</button>
							)}
							{completed > 0 && (
								<button className="sd-action-btn" onClick={() => queue.clearCompleted()}>
									Clear Done
								</button>
							)}
						</div>
					</div>
				</div>
			)}
		</>
	);
};

// --- 마운트 ---

export const mountPanel = (queue: DownloadQueue, unloads: Set<{ (): void }>) => {
	const container = document.createElement("div");
	container.id = "sd-panel-root";
	document.body.appendChild(container);

	// react-dom/client의 createRoot 사용
	const ReactDOM = (window as any).require("react-dom/client");
	const root = ReactDOM.createRoot(container);
	root.render(React.createElement(PanelRoot, { queue }));

	unloads.add(() => {
		root.unmount();
		container.remove();
	});
};
