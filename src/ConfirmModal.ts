import { App, Modal } from 'obsidian';

export default class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'Confirm Action' });
		contentEl.createEl('p', { text: this.message });

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		
		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		const confirmButton = buttonContainer.createEl('button', { 
			text: 'Confirm',
			cls: 'mod-warning'
		});
		confirmButton.addEventListener('click', async () => {
			this.close();
			try {
				await this.onConfirm();
			} catch (error) {
				console.error('Error in confirmation callback:', error);
			}
		});

		confirmButton.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
