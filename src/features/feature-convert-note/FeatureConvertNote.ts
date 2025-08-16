import MeldEncrypt from "../../main.ts";
import { IMeldEncryptPluginSettings } from "../../settings/MeldEncryptPluginSettings.ts";
import { IMeldEncryptPluginFeature } from "../IMeldEncryptPluginFeature.ts";
import { Notice, TFile, TextFileView } from "obsidian";
import PluginPasswordModal from "../../PluginPasswordModal.ts";
import { PasswordAndHint, SessionPasswordService } from "../../services/SessionPasswordService.ts";
import { FileDataHelper, JsonFileEncoding } from "../../services/FileDataHelper.ts";
import { Utils } from "../../services/Utils.ts";
import { DEFAULT_ENCRYPTABLE_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSIONS, ENCRYPTED_FILE_EXTENSION_DEFAULT, IMAGE_FILE_EXTENSIONS } from "../../services/Constants.ts";
import { EncryptedMarkdownView } from "../feature-whole-note-encrypt/EncryptedMarkdownView.ts";
import { EncryptedImageView } from "../feature-whole-note-encrypt/EncryptedImageView.ts";

export default class FeatureConvertNote implements IMeldEncryptPluginFeature {
	
	plugin: MeldEncrypt;
	
	async onload(plugin: MeldEncrypt, settings: IMeldEncryptPluginSettings) {
		this.plugin = plugin;

		this.plugin.addCommand({
			id: 'meld-encrypt-convert-to-or-from-encrypted-note',
			name: 'Convert to or from an Encrypted note',
			icon: 'file-lock-2',
			checkCallback: (checking) => this.processCommandConvertActiveNote( checking ),
		});

		this.plugin.addRibbonIcon(
			'file-lock-2',
			'Convert to or from an Encrypted note',
			(_) => this.processCommandConvertActiveNote( false )
		);


		this.plugin.registerEvent(
			this.plugin.app.workspace.on( 'file-menu', (menu, file) => {
				if (file instanceof TFile){
					if (DEFAULT_ENCRYPTABLE_FILE_EXTENSIONS.includes( file.extension ) ){
						menu.addItem( (item) => {
							item
								.setTitle('Encrypt note')
								.setIcon('file-lock-2')
								.onClick( () => this.processCommandEncryptNote( file ) );
							}
						);
					}
					if ( ENCRYPTED_FILE_EXTENSIONS.includes( file.extension ) ){
						menu.addItem( (item) => {
							item
								.setTitle('Decrypt note')
								.setIcon('file')
								.onClick( () => this.processCommandDecryptNote( file ) );
							}
						);
					}
				}
			})
		);

	}
	
	onunload(): void { }

	buildSettingsUi(containerEl: HTMLElement, saveSettingCallback: () => Promise<void>): void { }

	private checkCanEncryptFile( file:TFile | null ) : boolean {
		if ( file == null ){
			return false;
		}
		return DEFAULT_ENCRYPTABLE_FILE_EXTENSIONS.includes(file.extension);
	}

	private checkCanDecryptFile( file:TFile | null ) : boolean {
		if ( file == null ){
			return false;
		}
		return ENCRYPTED_FILE_EXTENSIONS.includes( file.extension );
	}

	private isImageFile( file:TFile | null ) : boolean {
		if ( file == null ){
			return false;
		}
		return IMAGE_FILE_EXTENSIONS.includes(file.extension.toLowerCase());
	}

	private processCommandEncryptNote( file:TFile ){
		this.getPasswordAndEncryptFile( file ).catch( reason => {
			if (reason){
				new Notice(reason, 10000);
			}
		});
	}

	private processCommandDecryptNote( file:TFile ){
		this.getPasswordAndDecryptFile( file ).catch( reason => {
			if (reason){
				new Notice(reason, 10000);
			}
		});
	}

	private processCommandConvertActiveNote( checking: boolean ) : boolean | void {
		const file = this.plugin.app.workspace.getActiveFile();
		
		if (checking){
			return this.checkCanEncryptFile(file)
				|| this.checkCanDecryptFile(file)
			;
		}

		if ( file?.extension && DEFAULT_ENCRYPTABLE_FILE_EXTENSIONS.includes(file.extension) ){
			this.getPasswordAndEncryptFile( file ).catch( reason => {
				if (reason){
					new Notice(reason, 10000);
				}
			});
		}

		if ( file && ENCRYPTED_FILE_EXTENSIONS.includes( file.extension ) ){
			this.getPasswordAndDecryptFile( file ).catch( reason => {
				if (reason){
					new Notice(reason, 10000);
				}
			});
		}
	}

	private async getPasswordAndEncryptFile( file:TFile ) {

		if ( !this.checkCanEncryptFile(file) ) {
			throw new Error( 'Unable to encrypt file' );
		}

		try{

			// try to get password from session password service
			let password = await SessionPasswordService.getByFile( file );

			if ( password.password == '' ){
				// ask for password
				const pm = new PluginPasswordModal( this.plugin.app, 'Encrypt Note', true, true, password );
				password = await pm.openAsync();
			}

			const encryptedFileContent = await this.encryptFile(file, password);

			await this.closeUpdateRememberPasswordThenReopen(
				file,
				ENCRYPTED_FILE_EXTENSION_DEFAULT,
				encryptedFileContent,
				password
			);
			
			new Notice( '🔐 Note was encrypted 🔐' );

		}catch( error ){
			if (error){
				new Notice(error, 10000);
			}
		}
	}

	private async getPasswordAndDecryptFile( file:TFile ) {
		if ( !this.checkCanDecryptFile(file) ) {
			throw new Error( 'Unable to decrypt file' );
		}

		const encryptedFileContent = await this.plugin.app.vault.read( file );
		const encryptedData = JsonFileEncoding.decode( encryptedFileContent );
		const isOriginallyImage = encryptedData.originalFileExtension && IMAGE_FILE_EXTENSIONS.includes(encryptedData.originalFileExtension.toLowerCase());

		let passwordAndHint = await SessionPasswordService.getByFile( file );
		if ( passwordAndHint.password != '' ){
			// try to decrypt using saved password
			const decryptedContent = await this.decryptFile( file, passwordAndHint.password );
			if (decryptedContent != null){
				// Handle different file types
				if (isOriginallyImage && decryptedContent instanceof ArrayBuffer) {
					await this.closeUpdateRememberPasswordThenReopenBinary( file, encryptedData.originalFileExtension || 'png', decryptedContent, passwordAndHint );
				} else if (typeof decryptedContent === 'string') {
					await this.closeUpdateRememberPasswordThenReopen( file, encryptedData.originalFileExtension || 'md', decryptedContent, passwordAndHint );
				}
				return;
			}
		}
		
		const pwm = new PluginPasswordModal(this.plugin.app, 'Decrypt Note', false, false, { password: '', hint: encryptedData.hint } );
		try{
			passwordAndHint = await pwm.openAsync();
			
			if (!pwm.resultConfirmed){
				return;
			}
			
			const content = await this.decryptFile( file, passwordAndHint.password );
			if ( content == null ){
				throw new Error('Decryption failed');
			}

			if (isOriginallyImage && content instanceof ArrayBuffer) {
				await this.closeUpdateRememberPasswordThenReopenBinary( file, encryptedData.originalFileExtension || 'png', content, passwordAndHint );
			} else if (typeof content === 'string') {
				await this.closeUpdateRememberPasswordThenReopen( file, encryptedData.originalFileExtension || 'md', content, passwordAndHint );
			}

			new Notice( '🔓 Note was decrypted 🔓' );

		}catch(error){
			if (error){
				new Notice(error, 10000);
			}
		}
	}

	private async closeUpdateRememberPasswordThenReopen( file:TFile, newFileExtension: string, content: string, pw:PasswordAndHint ) {
		
		let didDetach = false;

		this.plugin.app.workspace.iterateAllLeaves( l => {
			if ( l.view instanceof TextFileView && l.view.file == file ){
				if ( l.view instanceof EncryptedMarkdownView ){
					l.view.detachSafely();
				}else{
					l.detach();
				}
				didDetach = true;
			}
		});

		try{
			const newFilepath = Utils.getFilePathWithNewExtension(file, newFileExtension);
			await this.plugin.app.fileManager.renameFile( file, newFilepath );
			await this.plugin.app.vault.modify( file, content );
			SessionPasswordService.putByFile( pw, file );
		}finally{
			if( didDetach ){
				await this.plugin.app.workspace.getLeaf( true ).openFile(file);
			}
		}
	}

	private async closeUpdateRememberPasswordThenReopenBinary( file:TFile, newFileExtension: string, binaryContent: ArrayBuffer, pw:PasswordAndHint ) {
		
		let didDetach = false;

		this.plugin.app.workspace.iterateAllLeaves( l => {
			if ( l.view instanceof TextFileView && l.view.file == file ){
				if ( l.view instanceof EncryptedImageView ){
					l.view.detachSafely();
				}else{
					l.detach();
				}
				didDetach = true;
			}
		});

		try{
			const newFilepath = Utils.getFilePathWithNewExtension(file, newFileExtension);
			await this.plugin.app.fileManager.renameFile( file, newFilepath );
			// For binary files, use createBinary instead of modify
			await this.plugin.app.vault.delete(file);
			await this.plugin.app.vault.createBinary( newFilepath, new Uint8Array(binaryContent) );
			// Update the file reference
			const newFile = this.plugin.app.vault.getAbstractFileByPath(newFilepath) as TFile;
			SessionPasswordService.putByFile( pw, newFile );
		}finally{
			if( didDetach ){
				const newFile = this.plugin.app.vault.getAbstractFileByPath(Utils.getFilePathWithNewExtension(file, newFileExtension)) as TFile;
				if (newFile) {
					await this.plugin.app.workspace.getLeaf( true ).openFile(newFile);
				}
			}
		}
	}

	private async encryptFile(file: TFile, passwordAndHint:PasswordAndHint ) : Promise<string> {
		let encryptedData: any;
		
		if (this.isImageFile(file)) {
			// Handle binary/image files
			const binaryContent = await this.plugin.app.vault.readBinary( file );
			encryptedData = await FileDataHelper.encryptBinary( passwordAndHint.password, passwordAndHint.hint, binaryContent, file.extension );
		} else {
			// Handle text files
			const content = await this.plugin.app.vault.read( file );
			encryptedData = await FileDataHelper.encrypt( passwordAndHint.password, passwordAndHint.hint, content, file.extension );
		}
		
		return JsonFileEncoding.encode( encryptedData );
	}

	private async decryptFile(file: TFile, password:string) : Promise<string | ArrayBuffer | null> {
		const encryptedFileContent = await this.plugin.app.vault.read( file );
		const encryptedData = JsonFileEncoding.decode( encryptedFileContent );
		
		// Check if this was originally an image file
		if (encryptedData.originalFileExtension && IMAGE_FILE_EXTENSIONS.includes(encryptedData.originalFileExtension.toLowerCase())) {
			// Return binary data for image files
			return await FileDataHelper.decryptBinary(encryptedData, password );
		} else {
			// Return text data for text files
			return await FileDataHelper.decrypt(encryptedData, password );
		}
	}
}