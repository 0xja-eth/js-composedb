
import {spawn as _spawn} from "child_process"

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

export function spawn(command, args) {
	if (isWindows) return _spawn(command, args)
	return _spawn(command.split(".")[0], args)
}
