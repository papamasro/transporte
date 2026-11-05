// Carga scripts clásicos del front (sin módulos) en un contexto vm aislado, como los carga index.html.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../../', import.meta.url);

export function loadScripts(paths, globals = {}) {
    const context = vm.createContext({
        console,
        URL,
        Map,
        Set,
        document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
        ...globals
    });
    context.globalThis = context;
    for (const path of paths) {
        vm.runInContext(readFileSync(new URL(path, ROOT), 'utf8'), context, { filename: path });
    }
    return context;
}
