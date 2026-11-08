// Hide the console window on Windows release builds (nika targets macOS and Linux; this is the template default).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nika_app_lib::run()
}
