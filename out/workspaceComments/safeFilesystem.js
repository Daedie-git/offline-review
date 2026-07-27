"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isContained = isContained;
exports.sameCanonicalPath = sameCanonicalPath;
exports.assertOrdinaryPath = assertOrdinaryPath;
exports.canonicalPath = canonicalPath;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}
function sameCanonicalPath(left, right) {
    return path.normalize(left) === path.normalize(right);
}
function assertOrdinaryPath(pathToCheck, kind) {
    let stat;
    try {
        stat = fs.lstatSync(pathToCheck);
    }
    catch (error) {
        throw new Error(`Cannot inspect ${pathToCheck}: ${errorMessage(error)}`);
    }
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
        throw new Error(`Unsafe workspace comments ${kind}: ${pathToCheck}`);
    }
}
function canonicalPath(pathToResolve) {
    return fs.realpathSync.native(pathToResolve);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=safeFilesystem.js.map