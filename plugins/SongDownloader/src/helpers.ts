import { MediaItem, type redux } from "@luna/lib";
import { showOpenDialog, showSaveDialog } from "@luna/lib.native";
import { settings } from "./Settings";

import sanitize from "sanitize-filename";

export const getDownloadFolder = async () => {
	const { canceled, filePaths } = await showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
	if (!canceled) return filePaths[0];
};
export const getDownloadPath = async (defaultPath: string) => {
	const { canceled, filePath } = await showSaveDialog({
		defaultPath,
		filters: [{ name: "", extensions: [defaultPath ?? "*"] }],
	});
	if (!canceled) return filePath;
};

/**
 * FLAC 태그 객체를 받아서 설정된 pathFormat에 따라 파일명을 생성한다.
 * DEFECT 3 수정: flacTags()를 호출자에서 한 번만 호출하고 결과를 전달받는다.
 */
export const getFileName = async (
	mediaItem: MediaItem,
	audioQuality: redux.AudioQuality | undefined,
	tags: Record<string, string | string[] | undefined>,
) => {
	let fileName = `${settings.pathFormat}.${await mediaItem.fileExtension(audioQuality)}`;
	for (const tag of MediaItem.availableTags) {
		let tagValue = tags[tag];
		if (Array.isArray(tagValue)) tagValue = tagValue[0];
		if (tagValue === undefined) continue;
		fileName = fileName.replaceAll(`{${tag}}`, sanitize(tagValue));
	}
	return fileName;
};
