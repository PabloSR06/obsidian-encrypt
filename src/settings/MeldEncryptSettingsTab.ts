import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { IMeldEncryptPluginFeature } from "../features/IMeldEncryptPluginFeature.ts";
import { SessionPasswordService } from "../services/SessionPasswordService.ts";
import MeldEncrypt from "../main.ts";
import { IMeldEncryptPluginSettings } from "./MeldEncryptPluginSettings.ts";
import ConfirmModal from "../ConfirmModal.ts";

export default class MeldEncryptSettingsTab extends PluginSettingTab {
	plugin: MeldEncrypt;
	settings: IMeldEncryptPluginSettings;

	features:IMeldEncryptPluginFeature[];

	constructor(
		app: App,
		plugin: MeldEncrypt,
		settings:IMeldEncryptPluginSettings,
		features: IMeldEncryptPluginFeature[]
	) {
		super(app, plugin);
		this.plugin = plugin;
		this.settings = settings;
		this.features = features;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		
		new Setting(containerEl)
			.setName('Confirm password?')
			.setDesc('Confirm password when encrypting. (Recommended)')
			.addToggle( toggle =>{
				toggle
					.setValue(this.settings.confirmPassword)
					.onChange( async value =>{
						this.settings.confirmPassword = value;
						await this.plugin.saveSettings();
					})
			})
		;

		const updateRememberPasswordSettingsUi = () => {
			
			if ( !this.settings.rememberPassword ){
				pwTimeoutSetting.settingEl.hide();
				rememberPasswordLevelSetting.settingEl.hide();
				return;
			}

			if ( this.settings.rememberPasswordLevel != SessionPasswordService.LevelExternalFile ){
				pwTimeoutSetting.settingEl.show();
				extFilePathsSetting.settingEl.hide();
			}else{
				pwTimeoutSetting.settingEl.hide();
				extFilePathsSetting.settingEl.show();
			}

			rememberPasswordLevelSetting.settingEl.show();

			const rememberPasswordTimeout = this.settings.rememberPasswordTimeout;

			let timeoutString = `For ${rememberPasswordTimeout} minutes`;
			if( rememberPasswordTimeout == 0 ){
				timeoutString = 'Until Obsidian is closed';
			}

			pwTimeoutSetting.setName( `Remember Password (${timeoutString})` )
		
		}

		new Setting(containerEl)
			.setName('Remember password?')
			.setDesc('Remember the last used passwords when encrypting or decrypting.  Passwords are remembered until they timeout or Obsidian is closed')
			.addToggle( toggle =>{
				toggle
					.setValue(this.settings.rememberPassword)
					.onChange( async value => {
						this.settings.rememberPassword = value;
						await this.plugin.saveSettings();
						SessionPasswordService.setActive( this.settings.rememberPassword );
						updateRememberPasswordSettingsUi();
					})
			})
		;

		const rememberPasswordLevelSetting = new Setting(containerEl)
			.setName('Remember passwords by:')
			.setDesc( this.buildRememberPasswordDescription() )
			.addDropdown( cb =>{
				cb
				.addOption( SessionPasswordService.LevelVault, 'Vault')
				.addOption( SessionPasswordService.LevelParentPath, 'Folder')
				.addOption( SessionPasswordService.LevelFilename, 'File')
				.addOption( SessionPasswordService.LevelExternalFile, 'External File')
					.setValue( this.settings.rememberPasswordLevel )
					.onChange( async value => {
						console.debug( 'rememberPasswordLevelSetting.onChange', { value } );
						this.settings.rememberPasswordLevel = value;
						await this.plugin.saveSettings();
						SessionPasswordService.setLevel( this.settings.rememberPasswordLevel );
						updateRememberPasswordSettingsUi();
					})
				;
			})
		;

		
		const pwTimeoutSetting = new Setting(containerEl)
			.setDesc('The number of minutes to remember passwords.')
			.addSlider( slider => {
				slider
					.setLimits(0, 120, 5)
					.setValue(this.settings.rememberPasswordTimeout)
					.onChange( async value => {
						this.settings.rememberPasswordTimeout = value;
						await this.plugin.saveSettings();
						SessionPasswordService.setAutoExpire( this.settings.rememberPasswordTimeout );
						updateRememberPasswordSettingsUi();
					})
				;
				
			})
		;

		const extFilePathsSetting = new Setting(containerEl)
			.setName( 'External File Paths' )
			.setDesc( 'When needed the password is read from one of these filepaths. Paths must be relative to vault root' )
			.addTextArea( text => {
				text
					.setValue( this.settings.rememberPasswordExternalFilePaths.join( '\n' ) )
					.onChange( async value => {
						this.settings.rememberPasswordExternalFilePaths = value.trim().split( '\n' );
						await this.plugin.saveSettings();
						SessionPasswordService.setExternalFilePaths( this.settings.rememberPasswordExternalFilePaths );
					})
				;
				text.inputEl.placeholder = 'Enter one relative path per line';
				text.inputEl.style.whiteSpace = 'pre';
				text.inputEl.style.width = '100%';
				text.inputEl.rows = 4;
			})
			.addButton( btn => {
				btn
					.setIcon( 'check' )
					.setTooltip( 'Check Paths' )
					.onClick( async () => {
						const filePaths = this.settings.rememberPasswordExternalFilePaths;
						for( const filePath of filePaths ){
							if (await SessionPasswordService.canFetchContents( filePath ) ){
								new Notice( `✔️ ${filePath}` );
							}else{
								new Notice( `❌ ${filePath}` );
							}
							
						}
					})
				;
			})
		;
		extFilePathsSetting.controlEl.style.width = '80%';

		updateRememberPasswordSettingsUi();

		// build feature settings
		this.features.forEach(f => {
			f.buildSettingsUi( containerEl, async () => await this.plugin.saveSettings() );
		});

		// Bulk encryption/decryption options
		containerEl.createEl('h2', { text: 'Bulk Operations' });

		new Setting(containerEl)
			.setName('Ignore paths for bulk operations')
			.setDesc('Files or folders to ignore during bulk encrypt/decrypt operations. Use glob patterns (e.g., "folder/**", "*.excalidraw.md"). One pattern per line.')
			.addTextArea(text => {
				text
					.setValue(this.settings.bulkOperationIgnorePaths.join('\n'))
					.onChange(async value => {
						this.settings.bulkOperationIgnorePaths = value
							.split('\n')
							.map(p => p.trim())
							.filter(p => p.length > 0);
						await this.plugin.saveSettings();
					});
				text.inputEl.placeholder = 'Examples:\nTemplates/**\n*.excalidraw.md\nArchive/Old Notes/**';
				text.inputEl.style.whiteSpace = 'pre';
				text.inputEl.style.width = '100%';
				text.inputEl.rows = 4;
			});

		new Setting(containerEl)
			.setName('Decrypt all notes')
			.setDesc('Decrypt all encrypted notes in the vault. You will be prompted for passwords as needed.')
			.addButton(button => {
				button
					.setButtonText('Decrypt All')
					.setWarning()
					.onClick(async () => {
						console.log('Decrypt All button clicked');
						console.log('Available features:', this.features.map(f => f.constructor.name));
						new ConfirmModal(
							this.app,
							'Are you sure you want to decrypt all encrypted notes in the vault? This action cannot be undone automatically.',
							async () => {
								console.log('User confirmed decryption');
								const wholeNoteFeature = this.features.find(f => 'decryptAllNotes' in f);
								console.log('Found feature:', wholeNoteFeature?.constructor.name);
								if (wholeNoteFeature && 'decryptAllNotes' in wholeNoteFeature) {
									console.log('Calling decryptAllNotes...');
									await (wholeNoteFeature as any).decryptAllNotes();
								} else {
									console.error('Feature not found or method not available');
								}
							}
						).open();
					});
			});

		new Setting(containerEl)
			.setName('Encrypt all notes')
			.setDesc('Encrypt all unencrypted markdown notes in the vault. You will be prompted for passwords as needed.')
			.addButton(button => {
				button
					.setButtonText('Encrypt All')
					.setWarning()
					.onClick(async () => {
						console.log('Encrypt All button clicked');
						console.log('Available features:', this.features.map(f => f.constructor.name));
						new ConfirmModal(
							this.app,
							'Are you sure you want to encrypt all unencrypted markdown notes in the vault? This action cannot be undone automatically.',
							async () => {
								console.log('User confirmed encryption');
								const wholeNoteFeature = this.features.find(f => 'encryptAllNotes' in f);
								console.log('Found feature:', wholeNoteFeature?.constructor.name);
								if (wholeNoteFeature && 'encryptAllNotes' in wholeNoteFeature) {
									console.log('Calling encryptAllNotes...');
									await (wholeNoteFeature as any).encryptAllNotes();
								} else {
									console.error('Feature not found or method not available');
								}
							}
						).open();
					});
			});
		
	}

	private buildRememberPasswordDescription( ) : DocumentFragment {
		const f = new DocumentFragment();

		const tbody = f.createEl( 'table' ).createTBody();

		
		let tr = tbody.createEl( 'tr' );
		tr.createEl( 'th', { text: 'Vault:', attr: { 'align': 'right'} });
		tr.createEl( 'td', { text: 'Typically, you\'ll use the same password every time.' });
		
		tr = tbody.createEl( 'tr' );
		tr.createEl( 'th', { text: 'Folder:', attr: { 'align': 'right'} });
		tr.createEl( 'td', { text: 'Typically, you\'ll use the same password for each note within a folder.' });
		
		tr = tbody.createEl( 'tr' );
		tr.createEl( 'th', { text: 'File:', attr: { 'align': 'right'} });
		tr.createEl( 'td', { text: 'Typically, each note will have a unique password.' });
		
		tr = tbody.createEl( 'tr' );
		tr.createEl( 'th', { text: 'External File:', attr: { 'align': 'right', 'style': 'width:12em;'} });
		tr.createEl( 'td', { text: 'When needed the password/key is read from one of these filepaths.' });

		return f;
	}

}