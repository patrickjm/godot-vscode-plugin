import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { globals } from "../../extension";
import { createLogger, make_docs_uri } from "../../utils";
import { SceneHandler } from "../scene_handler";
import type { Scene, SceneNode } from "../types";
import type { PropertyData } from "./types";
import { extractPropertyValue } from "./utils";

const log = createLogger("scenes.property_inspector.webview_provider");

export class NodePropertiesWebviewProvider implements vscode.WebviewViewProvider {
	private webviewView?: vscode.WebviewView;
	private currentNodeName = "";
	private currentNode?: SceneNode;
	private currentScene?: Scene;
	private propertiesByClass = new Map<string, PropertyData[]>();
	private parser = new SceneHandler();

	constructor(private extensionUri: vscode.Uri) {}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.webviewView = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri]
		};

		// Handle messages from the webview
		webviewView.webview.onDidReceiveMessage(
			(message: any) => {
				if (message.type === 'propertyChange') {
					this.handlePropertyChange(message.propertyName, message.newValue, message.propertyType);
				} else if (message.type === 'propertyReset') {
					this.handlePropertyReset(message.propertyName);
				} else if (message.type === 'openDocumentation') {
					// Open documentation for the specified class
					const uri = make_docs_uri(message.className);
					vscode.commands.executeCommand("vscode.open", uri);
				}
			}
		);

		// Set the webview HTML
		this.webviewView.webview.html = this.getWebviewHtml(webviewView.webview);
		
		// Send initial empty state
		this.updateContent();
	}

	public setNodeProperties(
		nodeName: string, 
		node: SceneNode, 
		scene: Scene, 
		propertiesByClass: Map<string, PropertyData[]>
	) {
		this.currentNodeName = nodeName;
		this.currentNode = node;
		this.currentScene = scene;
		this.propertiesByClass = propertiesByClass;
		this.updateContent();
	}

	public clearProperties() {
		this.currentNodeName = "";
		this.currentNode = undefined;
		this.currentScene = undefined;
		this.propertiesByClass.clear();
		this.updateContent();
	}

	public getCurrentNodeName(): string {
		return this.currentNodeName;
	}

	private async handlePropertyChange(propertyName: string, newValue: string, propertyType: string) {
		if (!this.currentNode || !this.currentScene) {
			log.warn("Cannot change property: no current node or scene");
			return;
		}

		log.info(`Handling property change: ${propertyName} = ${newValue} (type: ${propertyType})`);

		try {
			// Get default value for this property
			let defaultValue = '';
			for (const [className, properties] of this.propertiesByClass) {
				const property = properties.find(p => p.property.name === propertyName);
				if (property) {
					defaultValue = extractPropertyValue(property.property);
					break;
				}
			}

			await this.parser.updatePropertyInSceneFile(
				this.currentScene,
				this.currentNode,
				propertyName,
				newValue,
				propertyType,
				defaultValue
			);
			
			// Update the current value in our data structure
			let propertyFound = false;
			for (const [className, properties] of this.propertiesByClass) {
				const property = properties.find(p => p.property.name === propertyName);
				if (property) {
					log.info(`Updating property ${propertyName} in class ${className} from ${property.currentValue} to ${newValue}`);
					property.currentValue = newValue;
					propertyFound = true;
					break;
				}
			}
			
			if (!propertyFound) {
				log.warn(`Property ${propertyName} not found in properties data structure`);
			}
			
			// Re-parse current values from the updated node body to ensure consistency
			const currentValues = this.currentNode.getPropertyValues();
			log.info(`Re-parsed node property values:`, Object.fromEntries(currentValues));

			// Update the webview
			this.updateContent();
			
		} catch (error) {
			log.error(`Failed to update property ${propertyName}: ${error}`);
			vscode.window.showErrorMessage(`Failed to update property: ${error.message}`);
		}
	}

	private async handlePropertyReset(propertyName: string) {
		if (!this.currentNode || !this.currentScene) {
			log.warn("Cannot reset property: no current node or scene");
			return;
		}

		try {
			// Find the property to get its default value
			let defaultValue = '';
			let propertyType = '';
			
			for (const [className, properties] of this.propertiesByClass) {
				const property = properties.find(p => p.property.name === propertyName);
				if (property) {
					defaultValue = extractPropertyValue(property.property);
					propertyType = property.property.detail?.split(':')[1]?.split('=')[0]?.trim() || 'unknown';
					break;
				}
			}

			// Remove the property from scene file (since default values don't need to be stored)
			await this.parser.removePropertyFromSceneFile(
				this.currentScene,
				this.currentNode,
				propertyName
			);
			
			// Update the current value in our data structure
			for (const [className, properties] of this.propertiesByClass) {
				const property = properties.find(p => p.property.name === propertyName);
				if (property) {
					property.currentValue = defaultValue;
					break;
				}
			}

			// Update the webview
			this.updateContent();
			
		} catch (error) {
			log.error(`Failed to reset property ${propertyName}: ${error}`);
			vscode.window.showErrorMessage(`Failed to reset property: ${error.message}`);
		}
	}

	private updateContent() {
		if (!this.webviewView) {
			return;
		}

		// Convert Map to plain object for JSON serialization
		const propertiesByClassObj: { [key: string]: PropertyData[] } = {};
		for (const [className, properties] of this.propertiesByClass) {
			propertiesByClassObj[className] = properties;
		}

		// Get list of documented classes
		const documentedClasses = Array.from(this.propertiesByClass.keys())
			.filter(className => globals.docsProvider?.classInfo?.has(className) || false);

		if (this.propertiesByClass.size === 0) {
			this.webviewView.webview.postMessage({
				type: 'clearProperties'
			});
		} else {
			this.webviewView.webview.postMessage({
				type: 'updateProperties',
				nodeName: this.currentNodeName,
				propertiesByClass: propertiesByClassObj,
				documentedClasses
			});
		}
	}

	private getWebviewHtml(webview: vscode.Webview): string {
		// Get paths to resources
		const webviewDistPath = path.join(this.extensionUri.fsPath, 'src', 'scene_tools', 'property_inspector', 'webview', 'dist');
		const scriptUri = webview.asWebviewUri(vscode.Uri.file(path.join(webviewDistPath, 'webview.js')));
		
		// Read the HTML template
		const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'scene_tools', 'property_inspector', 'webview', 'src', 'index.html');
		let html = fs.readFileSync(htmlPath, 'utf8');
		
		// Replace placeholders
		html = html.replace(/{{cspSource}}/g, webview.cspSource);
		
		// Add script tag before closing body
		html = html.replace('</body>', `<script src="${scriptUri}"></script></body>`);
		
		return html;
	}
} 