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
exports.AuthorIdentity = void 0;
const os = __importStar(require("os"));
/** Resolves one stable mutation author without repeating synchronous OS account lookups. */
class AuthorIdentity {
    constructor(environment = process.env, userInfo = () => os.userInfo()) {
        this.environment = environment;
        this.userInfo = userInfo;
    }
    get() {
        if (this.cached !== undefined) {
            return this.cached;
        }
        const environmentAuthor = nonempty(this.environment.USER)
            ?? nonempty(this.environment.USERNAME);
        this.cached = environmentAuthor ?? this.userInfo().username;
        return this.cached;
    }
}
exports.AuthorIdentity = AuthorIdentity;
function nonempty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
//# sourceMappingURL=authorIdentity.js.map