import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const GAME_BOOK_DIR = path.resolve(__dirname, "../../game-book");
export const NODES_DIR = path.join(GAME_BOOK_DIR, "nodes");
export const INDEX_PATH = path.join(GAME_BOOK_DIR, "_index.yaml");
export const SCHEMA_PATH = path.join(GAME_BOOK_DIR, "_schema.yaml");
export const AUDIENCE_REVIEW_PATH = path.join(GAME_BOOK_DIR, "_audience-review.yaml");
export const NAME_RULES_DIR = path.resolve(__dirname, "../name-rules");
