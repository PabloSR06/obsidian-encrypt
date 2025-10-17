#!/bin/bash

# Script to build and install the plugin to your Obsidian vault

VAULT_PATH="/home/fire/Documents/Testing/.obsidian/plugins"
PLUGIN_NAME="meld-encrypt-vp"

echo "Building plugin..."
npm run build

if [ $? -eq 0 ]; then
    echo "Build successful!"
    echo "Installing to vault at: $VAULT_PATH"
    
    # Copy the plugin files
    cp -rv dist/meld-encrypt-vp-*/meld-encrypt-vp "$VAULT_PATH/"
    
    echo "✅ Plugin installed successfully!"
    echo ""
    echo "Next steps:"
    echo "1. Open Obsidian"
    echo "2. Go to Settings → Community plugins"
    echo "3. Reload the plugin or restart Obsidian"
else
    echo "❌ Build failed. Please check the errors above."
    exit 1
fi
