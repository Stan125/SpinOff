serve:
	python3 -m http.server 8080

stop:
	@pkill -f "python3 -m http.server 8080" && echo "Server stopped." || echo "No server running."
