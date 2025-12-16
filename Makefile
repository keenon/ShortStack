# Defaults
ICON_SOURCE ?= app-icon-mac.png

.PHONY: all dev clean icon help

# Default target: Build the release application
all:
	npm run tauri build

# Run the app in development mode (hot reloading)
dev:
	npm run tauri dev

# Clean build artifacts (fixes path errors when renaming folders)
clean:
	rm -rf src-tauri/target
	rm -rf dist

# Generate app icons
# Usage: make icon OR make icon ICON_SOURCE=./my-logo.png
icon:
	npm run tauri icon $(ICON_SOURCE)

# Show help
help:
	@echo "Available commands:"
	@echo "  make        - Build the app for production"
	@echo "  make dev    - Run the development server"
	@echo "  make clean  - Remove build artifacts (fixes path issues)"
	@echo "  make icon   - Generate icons from $(ICON_SOURCE)"