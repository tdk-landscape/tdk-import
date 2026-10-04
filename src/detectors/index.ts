// Registration order is merge precedence: Compose, then Dockerfile, then package.json, then Procfile.
// A new importer is one module registered here plus a fixture.
import "./compose.js";
import "./dockerfile.js";
import "./package-json.js";
import "./procfile.js";
