//! macOS only: things the shell does to its own process before any window exists.

use objc2_foundation::{ns_string, NSArgumentDomain, NSMutableDictionary, NSNumber, NSString, NSUserDefaults};

/// Sets `key` to `value` in `NSArgumentDomain` (the launch-argument layer: first in the search list, in memory only,
/// never written to the app's plist), keeping every key that is already there. `setVolatileDomain:forName:` refuses an
/// existing domain, so the domain is read, merged, removed and set again.
fn set_bool_in_argument_domain(key: &NSString, value: bool) {
    let defaults = NSUserDefaults::standardUserDefaults();
    // SAFETY: an immutable `NSString` constant exported by Foundation.
    let domain = unsafe { NSArgumentDomain };
    let merged = NSMutableDictionary::dictionaryWithDictionary(&defaults.volatileDomainForName(domain));
    merged.insert(key, &NSNumber::new_bool(value));
    defaults.removeVolatileDomainForName(domain);
    // SAFETY: the dictionary holds `NSString` keys and `NSObject` values, as the method requires.
    unsafe { defaults.setVolatileDomain_forName(&merged, domain) };
}

/// A held key repeats instead of opening the accent popup. Call before any window or webview exists.
pub fn disable_press_and_hold() {
    set_bool_in_argument_domain(ns_string!("ApplePressAndHoldEnabled"), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn press_and_hold_is_off_in_the_argument_domain_and_other_launch_arguments_survive() {
        let defaults = NSUserDefaults::standardUserDefaults();
        // a launch argument that was there before (`-key plistvalue` on the command line)
        let sentinel = ns_string!("NikaTestLaunchArgument");
        set_bool_in_argument_domain(sentinel, true);
        assert!(defaults.boolForKey(sentinel));
        disable_press_and_hold();
        // (+) the standard defaults now read press-and-hold as off
        assert!(!defaults.boolForKey(ns_string!("ApplePressAndHoldEnabled")));
        // (+) the argument that existed before is still there
        assert!(defaults.boolForKey(sentinel));
        // (+) and the key lives in the argument domain, not in a plist
        let domain = defaults.volatileDomainForName(unsafe { NSArgumentDomain });
        assert!(domain.objectForKey(ns_string!("ApplePressAndHoldEnabled")).is_some());
        // (+) calling it twice changes nothing
        disable_press_and_hold();
        assert!(!defaults.boolForKey(ns_string!("ApplePressAndHoldEnabled")));
        assert!(defaults.boolForKey(sentinel));
    }
}
