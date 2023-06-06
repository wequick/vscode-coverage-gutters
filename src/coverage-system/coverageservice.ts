import { Section } from "lcov-parse";
import {
    Disposable,
    FileSystemWatcher,
    OutputChannel,
    TextEditor,
    window,
    workspace,
} from "vscode";

import { Config } from "../extension/config";
import { StatusBarToggler } from "../extension/statusbartoggler";
import { CoverageParser } from "../files/coverageparser";
import { FilesLoader } from "../files/filesloader";
import { Renderer } from "./renderer";
import { SectionFinder } from "./sectionfinder";

enum Status {
    ready = "READY",
    initializing = "INITIALIZING",
    loading = "LOADING",
    rendering = "RENDERING",
    error = "ERROR",
}

export class CoverageService {
    private statusBar: StatusBarToggler;
    private configStore: Config;
    private outputChannel: OutputChannel;
    private filesLoader: FilesLoader;
    private renderer: Renderer;
    private isCoverageDisplayed = false;

    private coverageParser: CoverageParser;
    private coverageWatcher: FileSystemWatcher | undefined;
    private editorWatcher: Disposable | undefined;
    private sectionFinder: SectionFinder;

    private cache: Map<string, Section>;

    constructor(
        configStore: Config,
        outputChannel: OutputChannel,
        statusBar: StatusBarToggler,
    ) {
        this.configStore = configStore;
        this.outputChannel = outputChannel;
        this.updateServiceState(Status.initializing);
        this.cache = new Map();
        this.filesLoader = new FilesLoader(configStore);
        this.sectionFinder = new SectionFinder(
            configStore,
            this.outputChannel,
        );
        this.renderer = new Renderer(
            configStore,
            this.sectionFinder,
        );
        this.coverageParser = new CoverageParser(this.outputChannel);
        this.statusBar = statusBar;
    }

    public dispose() {
        if (this.coverageWatcher) { this.coverageWatcher.dispose(); }
        if (this.editorWatcher) { this.editorWatcher.dispose(); }
        this.cache = new Map(); // reset cache to empty
        this.renderer.renderCoverage(this.cache, window.visibleTextEditors);
    }

    public async displayForFile() {
        await this.loadCacheAndProcess();
        this.isCoverageDisplayed = true;
    }

    public async toggleCoverage() {
        if (this.isCoverageDisplayed) {
            this.removeCoverageForCurrentEditor();
        } else {
            await this.displayForFile();
        }
    }

    public async watchWorkspace() {
        await this.displayForFile();
        this.listenToFileSystem();
        this.listenToEditorEvents();
    }

    public async removeCoverageForCurrentEditor() {
        try {
            this.statusBar.setLoading(true);
            this.renderer.renderCoverage(new Map(), window.visibleTextEditors);
        } finally {
            this.statusBar.setLoading(false);
            this.isCoverageDisplayed = false;
        }
    }

    private async loadCache() {
        this.updateServiceState(Status.loading);
        const files = await this.filesLoader.findCoverageFiles();
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: Loading ${files.size} file(s)`,
        );
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: ${Array.from(files.values())}`,
        );
        const dataFiles = await this.filesLoader.loadDataFiles(files);
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: Loaded ${dataFiles.size} data file(s)`,
        );
        const dataCoverage = await this.coverageParser.filesToSections(dataFiles);
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: Caching ${dataCoverage.size} coverage(s)`,
        );

        this.cache = dataCoverage;
        this.updateServiceState(Status.ready);
    }

    private updateServiceState(state: Status) {
        this.outputChannel.appendLine(
            `[${Date.now()}][coverageservice]: ${state}`);
    }

    private async loadCacheAndProcess() {
        try {
            this.statusBar.setLoading(true);
            await this.loadCache();
            this.updateServiceState(Status.rendering);
            this.renderer.renderCoverage(this.cache, window.visibleTextEditors);
            this.setStatusBarCoverage(this.cache, window.activeTextEditor);
            this.updateServiceState(Status.ready);
        } finally {
            this.statusBar.setLoading(false);
        }
    }

    private listenToFileSystem() {
        let blobPattern;
        // Monitor only manual coverage files if the user has defined them
        if (this.configStore.manualCoverageFilePaths.length) {
            // Paths outside of workspace folders will not be watchable,
            // but those that are inside workspace will still work as expected
            blobPattern = `{${this.configStore.manualCoverageFilePaths}}`;
        } else {
            const fileNames = this.configStore.coverageFileNames.toString();

            let baseDir = this.configStore.coverageBaseDir;
            if (workspace.workspaceFolders) {
                // Prepend workspace folders glob to the folder lookup glob
                // This allows watching within all the workspace folders
                const workspaceFolders = workspace.workspaceFolders.map((wf) => wf.uri.fsPath);
                baseDir = `{${workspaceFolders}}/${baseDir}`;
            }
            // Creates a BlobPattern for all coverage files.
            // EX: `{/path/to/workspace1, /path/to/workspace2}/**/{cov.xml, lcov.info}`
            blobPattern = `${baseDir}/{${fileNames}}`;
        }
        const outputMessage = `[${Date.now()}][coverageservice]: Listening to file system at ${blobPattern}`;
        this.outputChannel.appendLine(outputMessage);

        this.coverageWatcher = workspace.createFileSystemWatcher(blobPattern);
        this.coverageWatcher.onDidChange(this.loadCacheAndProcess.bind(this));
        this.coverageWatcher.onDidCreate(this.loadCacheAndProcess.bind(this));
        this.coverageWatcher.onDidDelete(this.loadCacheAndProcess.bind(this));
    }

    private setStatusBarCoverage(sections: Map<string, Section>, textEditor: TextEditor | undefined ) {
        try {
            if (!textEditor) {
                return this.statusBar.setCoverage(undefined);
            }
            const [fileCoverage] = this.sectionFinder.findSectionsForEditor(textEditor, sections);
            const covered = fileCoverage?.lines?.hit;
            const total = fileCoverage?.lines?.found;
            const b_covered = fileCoverage?.branches?.hit || 0;
            const b_total = fileCoverage?.branches?.found || 1;

            let total_lines_hit = 0;
            let total_lines_found = 0;
            let total_branches_hit = 0;
            let total_branches_found = 0;
            sections.forEach( it => {
                total_lines_hit += it?.lines?.hit;
                total_lines_found += it?.lines?.found;
                total_branches_hit += it?.branches?.hit || 0;
                total_branches_found += it?.branches?.found || 0;
            });
            const coverage = Math.round((covered / total) * 100 );
            const total_coverage = total_lines_found == 0 ? 0 :
                Math.round((total_lines_hit / total_lines_found) * 100 );
            const b_coverage = Math.round((b_covered / b_total) * 100 );
            const b_total_coverage = total_branches_found == 0 ? 0 :
            Math.round((total_branches_hit / total_branches_found) * 100 );

            return this.statusBar.setCoverage(coverage, total_coverage, b_coverage, b_total_coverage);
        } catch {
            return this.statusBar.setCoverage(undefined);
        }
    }

    private handleEditorEvents() {
        try {
            this.updateServiceState(Status.rendering);
            this.statusBar.setLoading(true);
            this.renderer.renderCoverage(this.cache, window.visibleTextEditors || []);
            this.setStatusBarCoverage(this.cache, window.activeTextEditor);
            this.updateServiceState(Status.ready);
        } finally {
            this.statusBar.setLoading(false);
        }
    }

    private listenToEditorEvents() {
        this.editorWatcher = window.onDidChangeActiveTextEditor(
            this.handleEditorEvents.bind(this),
        );
    }
}
