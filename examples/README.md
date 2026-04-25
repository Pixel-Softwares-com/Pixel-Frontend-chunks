# Examples

These examples show the intended public API without requiring a build step.

## Browser form

Open `basic-form.html` in a Laravel page or copy the markup into a Blade view. The example sends a normal `FormData` request through `send()`, keeps a snapshot on failure, and restores pending snapshot metadata on page load.

## Laravel cleanup

Schedule expired server-side chunk cleanup:

```php
use Illuminate\Support\Facades\Schedule;

Schedule::command('chunk-transport:purge')->hourly();
```
