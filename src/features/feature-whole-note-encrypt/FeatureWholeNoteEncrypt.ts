import MeldEncrypt from "../../main.ts";
import { IMeldEncryptPluginFeature } from "../IMeldEncryptPluginFeature.ts";
import { EncryptedMarkdownView } from "./EncryptedMarkdownView.ts";
import { EncryptedImageView } from "./EncryptedImageView.ts";
import { MarkdownView, TFolder, normalizePath, moment, TFile, FileView, Setting, Notice } from "obsidian";
import PluginPasswordModal from "../../PluginPasswordModal.ts";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService.ts";
import { FileDataHelper, JsonFileEncoding } from "../../services/FileDataHelper.ts";
import { ENCRYPTED_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSION_DEFAULT, IMAGE_FILE_EXTENSIONS, POTENTIALLY_ENCRYPTED_FILE_EXTENSIONS } from "../../services/Constants.ts";
import { Utils } from "../../services/Utils.ts";

export default class FeatureWholeNoteEncryptV2 implements IMeldEncryptPluginFeature {

	plugin: MeldEncrypt;

	private statusIndicator: HTMLElement;

	private shouldIgnorePath(filePath: string, ignorePatterns: string[]): boolean {
		if (ignorePatterns.length === 0) {
			return false;
		}

		for (const pattern of ignorePatterns) {
			// Convert glob-like pattern to regex
			// Support for ** (any directory), * (any characters except /), and exact matches
			let regexPattern = pattern
				.replace(/\./g, '\\.')  // Escape dots
				.replace(/\*\*/g, ':::DOUBLESTAR:::')  // Temporarily replace **
				.replace(/\*/g, '[^/]*')  // * matches anything except /
				.replace(/:::DOUBLESTAR:::/g, '.*');  // ** matches anything including /

			// If pattern doesn't end with /**, add end anchor
			if (!pattern.endsWith('/**')) {
				regexPattern = '^' + regexPattern + '$';
			} else {
				regexPattern = '^' + regexPattern;
			}

			const regex = new RegExp(regexPattern);
			if (regex.test(filePath)) {
				console.log('shouldIgnorePath: Ignoring', filePath, 'due to pattern', pattern);
				return true;
			}
		}

		return false;
	}

	async onload( plugin: MeldEncrypt ) {
		this.plugin = plugin;
		//this.settings = settings.featureWholeNoteEncrypt;
		
		this.plugin.addRibbonIcon( 'file-lock-2', 'New encrypted note', async (ev)=>{
			await this.processCreateNewEncryptedNoteCommand( this.getDefaultFileFolder() );
		});

		this.plugin.addRibbonIcon( 'book-lock', 'Lock and Close all open encrypted notes', async (ev)=>{
			await this.processLockAndCloseAllEncryptedNotesCommand();
		});

		this.plugin.addCommand({
			id: 'meld-encrypt-create-new-note',
			name: 'Create new encrypted note',
			icon: 'file-lock-2',
			callback: async () => await this.processCreateNewEncryptedNoteCommand( this.getDefaultFileFolder() ),
		});

		this.plugin.addCommand({
			id: 'meld-encrypt-close-and-forget',
			name: 'Lock and Close all open encrypted notes',
			icon: 'book-lock',
			callback: async () => await this.processLockAndCloseAllEncryptedNotesCommand(),
		});

		this.plugin.addCommand({
			id: 'meld-encrypt-save-encrypted-note',
			name: 'Save encrypted note',
			icon: 'save',
			editorCheckCallback: (checking, editor, view) => {
				if (view instanceof EncryptedMarkdownView) {
					if (!checking) {
						view.saveManually();
					}
					return true;
				}
				return false;
			},
		});
		
		this.plugin.registerEvent(
			this.plugin.app.workspace.on( 'file-menu', (menu, file) => {
				if (file instanceof TFolder){
					menu.addItem( (item) => {
						item
							.setTitle('New encrypted note')
							.setIcon('file-lock-2')
							.onClick( () => this.processCreateNewEncryptedNoteCommand( file ) );
						}
					);
				}
			})
		);

		// configure status indicator
		this.statusIndicator = this.plugin.addStatusBarItem();
		this.statusIndicator.hide();
		this.statusIndicator.setText('🔐');

		// editor context menu
		this.plugin.registerEvent( this.plugin.app.workspace.on('editor-menu', async (menu, editor, view) => {
			if( view.file == null ){
				return;
			}
			
			const shouldHandle = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, view.file);
			if( !shouldHandle ){
				return;
			}
			
			if (view instanceof EncryptedMarkdownView){
				menu.addItem( (item) => {
					item
						.setTitle('Change Password')
						.setIcon('key-round')
						.onClick( async () => await view.changePassword() );
					}
				);
				menu.addItem( (item) => {
					item
						.setTitle('Lock & Close')
						.setIcon('lock')
						.onClick( () => view.lockAndClose() );
					}
				);
			}
		}));

		this.plugin.registerEvent( this.plugin.app.workspace.on('file-menu', async (menu, file) => {
			if ( !(file instanceof TFile) ){
				return
			}
			
			const shouldHandle = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file);
			if( !shouldHandle ){
				return;
			}

			const view = this.plugin.app.workspace.getActiveViewOfType( EncryptedMarkdownView );
			if (view == null || view.file != file){
				return;
			}

			menu.addItem( (item) => {
				item
					.setTitle('Change Password')
					.setIcon('key-round')
					.onClick( async () => await view.changePassword() );
				}
			);
			menu.addItem( (item) => {
				item
					.setTitle('Lock & Close')
					.setIcon('lock')
					.onClick( () => view.lockAndClose() );
				}
			);
		}))


		// register view
		this.plugin.registerView( EncryptedMarkdownView.VIEW_TYPE, (leaf) => {
			const view = new EncryptedMarkdownView(leaf);
			view.settings = this.plugin.getSettings();
			return view;
		});
		this.plugin.registerView( EncryptedImageView.VIEW_TYPE, (leaf) => new EncryptedImageView(leaf) );
		this.plugin.registerExtensions( ENCRYPTED_FILE_EXTENSIONS, EncryptedMarkdownView.VIEW_TYPE );

		// show status indicator for encrypted files, hide for others
		this.plugin.registerEvent( this.plugin.app.workspace.on('active-leaf-change', () => {
			const view = this.plugin.app.workspace.getActiveViewOfType(EncryptedMarkdownView);
			if (view == null){
				this.statusIndicator.hide();
				return;
			}
			this.statusIndicator.show();
		}));

		// make sure the view is the right type
		this.plugin.registerEvent(

			this.plugin.app.workspace.on('active-leaf-change', async (leaf) => {
				if ( leaf == null ){
					return;
				}

				let file: TFile | null = null;

				if ( leaf.view instanceof MarkdownView || leaf.view instanceof EncryptedMarkdownView || leaf.view instanceof EncryptedImageView ){
					file = leaf.view.file;
				} else {
					return;
				}

				if ( file == null ){
					return;
				}

				// Check if file should be handled as encrypted
				const shouldHandleAsEncrypted = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file);

				if ( shouldHandleAsEncrypted ){
					const appropriateViewType = await this.determineViewTypeForEncryptedFile(file);	

					if ( leaf.view instanceof EncryptedMarkdownView && appropriateViewType === EncryptedMarkdownView.VIEW_TYPE ){
						// console.log('Correct view already active: ' + appropriateViewType);
						return;
					}

					if ( leaf.view instanceof EncryptedImageView && appropriateViewType === EncryptedImageView.VIEW_TYPE ){
						// console.log('Correct view already active: ' + appropriateViewType);
						return;
					}

					// console.log('Switching to view type: ' + appropriateViewType);
					const viewState = leaf.getViewState();
					viewState.type = appropriateViewType;
					
					await leaf.setViewState( viewState );
				}

				return;			
			} )
		);

		// Also listen for file modifications to handle encryption/decryption changes
		this.plugin.registerEvent(
			this.plugin.app.vault.on('modify', async (file) => {
				if (!(file instanceof TFile) || file.extension !== 'md') {
					return;
				}

				// Small delay to ensure file content is properly updated
				setTimeout(async () => {
					// Find any open leaves with this file
					this.plugin.app.workspace.iterateAllLeaves((leaf) => {
						if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
							// Check if this file should now be handled as encrypted
							Utils.shouldHandleFileAsEncrypted(this.plugin.app, file).then(async (shouldHandleAsEncrypted) => {
								if (shouldHandleAsEncrypted) {
									console.log('Switching .md file to encrypted view:', file.path);
									const appropriateViewType = await this.determineViewTypeForEncryptedFile(file);
									const viewState = leaf.getViewState();
									viewState.type = appropriateViewType;
									await leaf.setViewState(viewState);
								}
							}).catch(error => {
								console.warn('Error checking if file should be encrypted:', error);
							});
						} else if (leaf.view instanceof EncryptedMarkdownView && leaf.view.file === file) {
							// Check if this file should no longer be handled as encrypted
							Utils.shouldHandleFileAsEncrypted(this.plugin.app, file).then(async (shouldHandleAsEncrypted) => {
								if (!shouldHandleAsEncrypted) {
									console.log('Switching .md file to normal markdown view:', file.path);
									const viewState = leaf.getViewState();
									viewState.type = 'markdown';
									await leaf.setViewState(viewState);
								}
							}).catch(error => {
								console.warn('Error checking if file should be decrypted:', error);
							});
						}
					});
				}, 150);
			})
		);

	}

	private async processLockAndCloseAllEncryptedNotesCommand(): Promise<void> {
		// loop through all open leaves
		const leaves = this.plugin.app.workspace.getLeavesOfType( EncryptedMarkdownView.VIEW_TYPE );
		for ( const leaf of leaves ) {
			const view = leaf.view as EncryptedMarkdownView;
			if ( view != null ){
				view.lockAndClose();
			}
		}
	}

	private getDefaultFileFolder() : TFolder {
		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile != null){
			return this.plugin.app.fileManager.getNewFileParent(activeFile.path);
		}else{
			return this.plugin.app.fileManager.getNewFileParent('');
		}
	}

	private async processCreateNewEncryptedNoteCommand( parentFolder: TFolder ) : Promise<void> {
		
		// Create .md files with encrypted JSON content instead of .mdenc files
		const newFilename = moment().format( `[Untitled] YYYYMMDD hhmmss[.md]`);
		const newFilepath = normalizePath( parentFolder.path + "/" + newFilename );
		
		let pwh : PasswordAndHint | undefined;
		
		if ( SessionPasswordService.getLevel() == SessionPasswordService.LevelExternalFile ){
			// if using external file for password, try and get the password
			pwh = await SessionPasswordService.getByPathAsync( newFilepath );
		}

		// if the password is unknown, prompt for it
		if ( !pwh ){
			// prompt for password
			const pwm = new PluginPasswordModal(
				this.plugin.app,
				'Please provide a password for encryption',
				true,
				true,
				await SessionPasswordService.getByPathAsync( newFilepath )
			);
			
			try{
				pwh = await pwm.openAsync();
			}catch(e){
				return; // cancelled
			}	
		}

		// create the new file
		const fileData = await FileDataHelper.encrypt( pwh.password, pwh.hint, '', 'md' )
		const fileContents = JsonFileEncoding.encode( fileData );
		const file = await this.plugin.app.vault.create( newFilepath, fileContents );
		
		// cache the password
		SessionPasswordService.putByFile( pwh, file );

		// open the file
		const leaf = this.plugin.app.workspace.getLeaf( true );
		await leaf.openFile( file );

	}

	private async determineViewTypeForEncryptedFile(file: TFile): Promise<string> {
		try {
			const fileContents = await this.plugin.app.vault.read(file);
			const encryptedData = JsonFileEncoding.decode(fileContents);
			
			if (encryptedData.originalFileExtension === 'md') {
				return EncryptedMarkdownView.VIEW_TYPE;
			} else if (encryptedData.originalFileExtension && IMAGE_FILE_EXTENSIONS.includes(encryptedData.originalFileExtension.toLowerCase())) {
				return EncryptedImageView.VIEW_TYPE;
			}

			// TODO: CREATE GENERIC VIEW FOR OTHER FILE TYPES IN CASE IS NOT MD OR IMAGE
			return EncryptedMarkdownView.VIEW_TYPE;

		} catch (error) {
			console.warn('Could not determine view type for encrypted file:', error);
			return EncryptedMarkdownView.VIEW_TYPE;
		}
	}

	onunload() {
		this.plugin.app.workspace.detachLeavesOfType(EncryptedMarkdownView.VIEW_TYPE);
		this.plugin.app.workspace.detachLeavesOfType(EncryptedImageView.VIEW_TYPE);
	}

	async decryptAllNotes(): Promise<void> {
		console.log('decryptAllNotes: Starting...');
		const files = this.plugin.app.vault.getMarkdownFiles();
		console.log('decryptAllNotes: Found', files.length, 'markdown files');
		const settings = this.plugin.getSettings();
		const ignorePatterns = settings.bulkOperationIgnorePaths || [];
		console.log('decryptAllNotes: Ignore patterns:', ignorePatterns);
		
		const encryptedFiles: TFile[] = [];
		let ignoredCount = 0;
		
		// Find all encrypted files (excluding ignored paths)
		for (const file of files) {
			// Check if path should be ignored
			if (this.shouldIgnorePath(file.path, ignorePatterns)) {
				ignoredCount++;
				continue;
			}

			// Verify file is actually encrypted
			const isEncrypted = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file);
			if (isEncrypted) {
				encryptedFiles.push(file);
			}
		}

		console.log('decryptAllNotes: Found', encryptedFiles.length, 'encrypted files');
		if (ignoredCount > 0) {
			console.log('decryptAllNotes: Ignored', ignoredCount, 'files based on patterns');
			new Notice(`Ignored ${ignoredCount} files based on ignore patterns`);
		}

		if (encryptedFiles.length === 0) {
			new Notice('No encrypted notes found in the vault');
			return;
		}

		new Notice(`Found ${encryptedFiles.length} encrypted notes. Starting decryption...`);

		// Get a common password first
		let commonPassword: PasswordAndHint | null = null;
		const cachedPwh = await SessionPasswordService.getByPathAsync('');
		
		if (cachedPwh && cachedPwh.password && cachedPwh.password.trim() !== '') {
			commonPassword = cachedPwh;
			console.log('decryptAllNotes: Using cached common password');
		} else {
			console.log('decryptAllNotes: Asking for common password');
			const pwm = new PluginPasswordModal(
				this.plugin.app,
				'Enter password for decrypting all notes (you can provide specific passwords later if needed)',
				false,
				false,
				null
			);
			
			try {
				commonPassword = await pwm.openAsync();
				console.log('decryptAllNotes: User provided common password');
			} catch (e) {
				console.log('decryptAllNotes: User cancelled, aborting');
				new Notice('Decryption cancelled');
				return;
			}
		}

		let successCount = 0;
		let failCount = 0;
		const failedFiles: TFile[] = [];

		// First pass: try with common password
		for (const file of encryptedFiles) {
			try {
				console.log('decryptAllNotes: Processing file:', file.path);
				
				// Double-check file is still encrypted
				const isStillEncrypted = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file);
				if (!isStillEncrypted) {
					console.log('decryptAllNotes: File is no longer encrypted, skipping:', file.path);
					continue;
				}

				const fileContents = await this.plugin.app.vault.read(file);
				const encryptedData = JsonFileEncoding.decode(fileContents);

				// Try to decrypt with common password
				console.log('decryptAllNotes: Attempting to decrypt with common password');
				let decryptedContent: string | null = null;
				try {
					decryptedContent = await FileDataHelper.decrypt(encryptedData, commonPassword.password);
				} catch (decryptError) {
					console.error('decryptAllNotes: Decryption error for', file.path, ':', decryptError);
					failedFiles.push(file);
					continue;
				}
				
				if (decryptedContent === null) {
					console.log('decryptAllNotes: Common password failed for:', file.path);
					failedFiles.push(file);
					continue;
				}

				// Save decrypted content
				await this.plugin.app.vault.modify(file, decryptedContent);
				console.log('decryptAllNotes: Successfully decrypted:', file.path);
				successCount++;
				
			} catch (error) {
				console.error('decryptAllNotes: Error decrypting file:', file.path, error);
				failedFiles.push(file);
			}
		}

		// Second pass: ask for specific passwords for failed files
		if (failedFiles.length > 0) {
			new Notice(`${failedFiles.length} files need specific passwords`);
			
			for (const file of failedFiles) {
				try {
					console.log('decryptAllNotes: Asking for specific password for:', file.path);
					const pwm = new PluginPasswordModal(
						this.plugin.app,
						`Specific password for: ${file.path}`,
						false,
						false,
						null
					);
					
					let pwh: PasswordAndHint;
					try {
						pwh = await pwm.openAsync();
					} catch (e) {
						console.log('decryptAllNotes: User cancelled password for:', file.path);
						new Notice(`Skipped: ${file.path}`);
						failCount++;
						continue;
					}

					const fileContents = await this.plugin.app.vault.read(file);
					const encryptedData = JsonFileEncoding.decode(fileContents);

					// Try to decrypt with specific password
					let decryptedContent: string | null = null;
					try {
						decryptedContent = await FileDataHelper.decrypt(encryptedData, pwh.password);
					} catch (decryptError) {
						console.error('decryptAllNotes: Decryption error for', file.path, ':', decryptError);
						new Notice(`Decryption error for ${file.path}`);
						failCount++;
						continue;
					}
					
					if (decryptedContent === null) {
						console.log('decryptAllNotes: Wrong specific password for:', file.path);
						new Notice(`Wrong password for: ${file.path}`);
						failCount++;
						continue;
					}

					// Save decrypted content
					await this.plugin.app.vault.modify(file, decryptedContent);
					console.log('decryptAllNotes: Successfully decrypted with specific password:', file.path);
					successCount++;
					
				} catch (error) {
					console.error('decryptAllNotes: Error decrypting file:', file.path, error);
					failCount++;
				}
			}
		}

		console.log('decryptAllNotes: Complete. Success:', successCount, 'Failed:', failCount);
		new Notice(`Decryption complete. Success: ${successCount}, Failed: ${failCount}`);
	}

	async encryptAllNotes(): Promise<void> {
		console.log('encryptAllNotes: Starting...');
		const files = this.plugin.app.vault.getMarkdownFiles();
		console.log('encryptAllNotes: Found', files.length, 'markdown files');
		const settings = this.plugin.getSettings();
		const ignorePatterns = settings.bulkOperationIgnorePaths || [];
		console.log('encryptAllNotes: Ignore patterns:', ignorePatterns);
		
		const unencryptedFiles: TFile[] = [];
		let ignoredCount = 0;
		
		// Find all unencrypted .md files (excluding ignored paths)
		for (const file of files) {
			// Check if path should be ignored
			if (this.shouldIgnorePath(file.path, ignorePatterns)) {
				ignoredCount++;
				continue;
			}

			// Verify file is actually unencrypted
			const isEncrypted = await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file);
			if (!isEncrypted) {
				unencryptedFiles.push(file);
			}
		}

		console.log('encryptAllNotes: Found', unencryptedFiles.length, 'unencrypted files');
		if (ignoredCount > 0) {
			console.log('encryptAllNotes: Ignored', ignoredCount, 'files based on patterns');
			new Notice(`Ignored ${ignoredCount} files based on ignore patterns`);
		}

		if (unencryptedFiles.length === 0) {
			new Notice('No unencrypted notes found in the vault');
			return;
		}

		new Notice(`Found ${unencryptedFiles.length} unencrypted notes. Starting encryption...`);

		// Get password once for all files
		let pwh: PasswordAndHint | undefined;
		
		if (SessionPasswordService.getLevel() === SessionPasswordService.LevelVault) {
			pwh = await SessionPasswordService.getByPathAsync('');
		}

		// Check if password is actually valid (not null/undefined and not empty)
		if (!pwh || !pwh.password || pwh.password.trim() === '') {
			console.log('encryptAllNotes: No valid cached password, prompting user');
			const pwm = new PluginPasswordModal(
				this.plugin.app,
				'Password for encrypting all notes',
				true,
				true,
				null
			);
			
			try {
				pwh = await pwm.openAsync();
			} catch (e) {
				console.log('encryptAllNotes: User cancelled');
				new Notice('Encryption cancelled');
				return;
			}
		}

		let successCount = 0;
		let failCount = 0;

		for (const file of unencryptedFiles) {
			try {
				console.log('encryptAllNotes: Processing file:', file.path);
				
				// Double-check file is still unencrypted
				const isStillUnencrypted = !(await Utils.shouldHandleFileAsEncrypted(this.plugin.app, file));
				if (!isStillUnencrypted) {
					console.log('encryptAllNotes: File is already encrypted, skipping:', file.path);
					continue;
				}

				const content = await this.plugin.app.vault.read(file);
				
				// Get password for this specific file if using per-file or per-folder passwords
				let filePassword = pwh;
				if (SessionPasswordService.getLevel() !== SessionPasswordService.LevelVault) {
					const specificPwh = await SessionPasswordService.getByPathAsync(file.path);
					// Check if password is actually valid (not null/undefined and not empty)
					if (specificPwh && specificPwh.password && specificPwh.password.trim() !== '') {
						filePassword = specificPwh;
					} else {
						// Ask for password for this file
						console.log('encryptAllNotes: No valid cached password for file, prompting user:', file.path);
						const pwm = new PluginPasswordModal(
							this.plugin.app,
							`Password for: ${file.path}`,
							true,
							true,
							null
						);
						
						try {
							filePassword = await pwm.openAsync();
						} catch (e) {
							console.log('encryptAllNotes: User cancelled password for:', file.path);
							new Notice(`Skipped: ${file.path}`);
							failCount++;
							continue;
						}
					}
				}

				// Encrypt the content
				const fileData = await FileDataHelper.encrypt(filePassword.password, filePassword.hint, content, 'md');
				const fileContents = JsonFileEncoding.encode(fileData);
				
				// Save encrypted content
				await this.plugin.app.vault.modify(file, fileContents);
				
				// Cache the password
				SessionPasswordService.putByFile(filePassword, file);
				
				console.log('encryptAllNotes: Successfully encrypted:', file.path);
				successCount++;
				
			} catch (error) {
				console.error('encryptAllNotes: Error encrypting file:', file.path, error);
				failCount++;
			}
		}

		console.log('encryptAllNotes: Complete. Success:', successCount, 'Failed:', failCount);
		new Notice(`Encryption complete. Success: ${successCount}, Failed: ${failCount}`);
	}

	buildSettingsUi(containerEl: HTMLElement, saveSettingCallback: () => Promise<void>): void {
		const settings = this.plugin.getSettings();
		

		const updateAutoSaveDelayUi = () => {
			const autoSaveMode = settings.featureWholeNoteEncrypt.autoSaveMode;
			
			if (autoSaveMode === 'delayed') {
				autoSaveDelaySetting.settingEl.show();
			} else {
				autoSaveDelaySetting.settingEl.hide();
			}
		};

		new Setting(containerEl)
			.setName('Auto-save mode')
			.setDesc('Choose when encrypted notes should be saved')
			.addDropdown(dropdown => {
				dropdown
					.addOption('auto', 'Auto (save immediately)')
					.addOption('delayed', 'Delayed (save after typing stops)')
					.addOption('manual', 'Manual (use save button only)')
					.setValue(settings.featureWholeNoteEncrypt.autoSaveMode)
					.onChange(async (value: 'auto' | 'manual' | 'delayed') => {
						settings.featureWholeNoteEncrypt.autoSaveMode = value;
						await saveSettingCallback();
						updateAutoSaveDelayUi();
					});
			});

		const autoSaveDelaySetting = new Setting(containerEl)
			.setName('Auto-save delay')
			.setDesc('Seconds to wait after typing stops before saving (1-30 seconds)')
			.addSlider(slider => {
				slider
					.setLimits(1, 30, 1)
					.setValue(settings.featureWholeNoteEncrypt.autoSaveDelay)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.featureWholeNoteEncrypt.autoSaveDelay = value;
						await saveSettingCallback();
					});
			});

		updateAutoSaveDelayUi();
	}

}
