// IndexedDB persistence. Media Blobs/Files are stored by the browser on disk, not in
// JS memory, and are read back as object URLs, so large projects survive reloads
// without holding hundreds of MB in the JS heap.
import { del, get, set } from "idb-keyval";

const PROJECT_KEY = "clearframe.project";
const blobKey = (id) => `clearframe.blob.${id}`;

export const saveBlob = (id, blob) => set(blobKey(id), blob);
export const getBlob = (id) => get(blobKey(id));
export const deleteBlob = (id) => del(blobKey(id));
export const saveProject = (json) => set(PROJECT_KEY, json);
export const loadProject = () => get(PROJECT_KEY);
