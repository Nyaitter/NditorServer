import {mkdir, rm} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const directory of ['build', 'dist']) {
    const target = resolve(root, directory);
    const location = relative(root, target);
    if (!location || location.startsWith('..') || isAbsolute(location)) {
        throw new Error('Build output must stay inside the project directory');
    }
    await rm(target, {recursive: true, force: true});
    await mkdir(target, {recursive: true});
}
