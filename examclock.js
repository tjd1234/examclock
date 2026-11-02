// examclock.js
//
// An HTML5 canvas-based timer for midterm and final exams. Plain JavaScript,
// no build step: edit this file directly.

"use strict";

(() => {
    const log = (msg) => console.log(msg);

    // includes endpoints: both lo and hi could be returned
    const randIntBetween = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1) + lo);

    // return a random element of an array
    const randChoice = (arr) => arr[randIntBetween(0, arr.length - 1)];

    //
    // yellow is a nice color
    //
    const yellow = "#ffffaa";

    //
    // used in the last 10 minutes; plain "orange" is hard to read on yellow
    // (1.9:1 contrast), this is 4.6:1
    //
    const dark_orange = "#c05000";

    //
    // used in the last minute; plain "red" on yellow is 3.8:1, this is 5.5:1
    //
    const dark_red = "#d00000";

    //
    // animation frame rate, used only while a reminder message is moving
    //
    const frame_rate = 30;

    //
    // proportionally map x from range [a, b] to range [c, d]
    //
    const map = (x, a, b, c, d) => c + (d - c) * (x - a) / (b - a);

    //
    // ensure x is in the range [lo, hi]
    //
    const constrain = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

    //
    // proportionally map x from range [a, b] to range [c, d],
    // and always return a value in [c, d]
    //
    const constrained_map = (x, a, b, c, d) => constrain(map(x, a, b, c, d), c, d);

    //
    // simple time formatting, e.g. "2:05pm" or "2:05:09pm"
    //
    const formatTime = (date, include_seconds = false) => {
        const hours = date.getHours();      // 0-23
        const minutes = date.getMinutes();  // 0-59
        const seconds = date.getSeconds();  // 0-59

        const am_pm = hours < 12 ? "am" : "pm";
        const h_str = hours % 12 === 0 ? "12" : (hours % 12).toString();
        const m_str = ":" + String(minutes).padStart(2, "0");
        const s_str = include_seconds ? ":" + String(seconds).padStart(2, "0") : "";

        return `${h_str}${m_str}${s_str}${am_pm}`;
    };

    const currentTimeString = (include_seconds = false) => formatTime(new Date(), include_seconds);

    //
    // keep the screen from dimming or sleeping while the clock is running
    //
    const keepScreenAwake = () => {
        if (!("wakeLock" in navigator)) {
            log("screen wake lock is not supported in this browser");
            return;
        }
        const request = async () => {
            try {
                await navigator.wakeLock.request("screen");
                log("screen wake lock acquired");
            } catch (err) {
                log(`screen wake lock failed: ${err.message}`);
            }
        };
        request();

        // the browser releases the lock when the tab is hidden, so
        // request it again when the tab becomes visible
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "visible") request();
        });
    };

    const mins_to_millis = (m) => 60 * m * 1000;

    const makeExam = (start, end) => {
        const dur_in_millis = end.getTime() - start.getTime();
        return {
            time: {
                start,
                end,
            },
            duration: {
                millis: dur_in_millis,
                seconds: dur_in_millis / 1000,
                minutes: dur_in_millis / mins_to_millis(1),
                hours: dur_in_millis / mins_to_millis(60),
            },
            remaining: {
                millis() { return end.getTime() - Date.now(); },
                seconds() { return Math.ceil(this.millis() / 1000); },
                minutes() { return Math.ceil(this.seconds() / 60); },
            },
            going() { return !this.finished(); },
            finished() { return this.remaining.millis() <= 0; },
        };
    };

    //
    // The running exam and the announcement text are saved in the browser
    // (localStorage), so reloading the page picks up where it left off.
    // Storage can be unavailable (e.g. private windows), so failures are ignored.
    //
    const storage = {
        get(key) {
            try { return localStorage.getItem(key); } catch { return null; }
        },
        set(key, value) {
            try { localStorage.setItem(key, value); } catch { /* not saved */ }
        },
        remove(key) {
            try { localStorage.removeItem(key); } catch { /* nothing to remove */ }
        },
    };

    const exam_key = "examclock.exam";
    const announcement_key = "examclock.announcement";
    // unlike the exam and announcement, these are kept when the timer is reset
    const reminders_key = "examclock.reminders";

    //
    // reminder messages the clock shows one at a time; they can be edited
    // on the page
    //
    const default_reminders = [
        "Put your name and SFU student ID # on each page.",
        "Raise your hand if you have a question or need to use the washroom.",
        "Read the questions carefully.",
        "Double-check your answers if you have time.",
        "Have mercy on your marker: write neatly!",
        "Pay attention to the details.",
        "Relax. Stay calm. Chill.",
        "Think!",
    ];

    // one message per line, ignoring blank lines
    const parseReminders = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "");

    // a saved exam is resumed until this long after it ends
    const resume_grace_millis = mins_to_millis(30);

    const saveExam = (exam) => {
        storage.set(exam_key, JSON.stringify({
            start: exam.time.start.getTime(),
            end: exam.time.end.getTime(),
        }));
    };

    // returns the saved exam, or null if there isn't one worth resuming
    const loadSavedExam = () => {
        try {
            const saved = JSON.parse(storage.get(exam_key));
            if (saved && Date.now() < saved.end + resume_grace_millis) {
                return makeExam(new Date(saved.start), new Date(saved.end));
            }
        } catch {
            // corrupt saved data: fall through and discard it
        }
        storage.remove(exam_key);
        return null;
    };

    // view is the canvas's size in CSS pixels: { width, height }
    const raw_label = (context, view) => ({
        make: (obj) => ({
            context,
            msg: obj.msg ?? "<label_msg>",
            x: obj.x ?? 100,
            y: obj.y ?? 100,
            style: obj.style ?? "black",
            font: obj.font ?? "25px serif",
            visible: obj.visible ?? true,
            measure(text) {
                this.context.save();
                this.context.font = this.font;
                this.context.fillStyle = this.style;
                const w = this.context.measureText(text).width;
                this.context.restore();
                return w;
            },
            getWidthInPixels() { return this.measure(this.msg); },
            uppercaseMwidth() { return this.measure("M"); },
            getHeightInPixels() { return this.uppercaseMwidth(); },
            render() {
                if (!this.visible) return;
                this.context.save();
                this.context.font = this.font;
                this.context.fillStyle = this.style;
                this.context.fillText(this.msg, this.x, this.y);
                this.context.restore();
            },
        }),

        put(msg, x = 25, y = 25, font = "25px serif", style = "black") {
            context.font = font;
            context.fillStyle = style;
            context.fillText(msg, x, y);
        },

        center(msg, y = 25, font = "25px serif", style = "black") {
            context.font = font;
            context.fillStyle = style;
            const x = (view.width - context.measureText(msg).width) / 2;
            context.fillText(msg, x, y);
        },
    });

    const canvasApp = () => {
        //
        // get the canvas and its context
        //
        const canvas = document.getElementById("canvasOne");
        if (!canvas.getContext) {
            log("canvas is NOT supported");
            return;
        }
        const context = canvas.getContext("2d");

        //
        // The clock is laid out for an area at least design.width x
        // design.height, and scaled up (or down) to fill the space the page
        // gives it, so it uses the whole screen on a big projector.
        //
        // Everything is drawn in layout units, in a view.width x view.height
        // area: view.height is always design.height, and view.width stretches
        // to fill the window's width. The canvas itself has devicePixelRatio
        // times as many pixels as it takes on screen, so text and lines are
        // sharp on high-density screens and projectors.
        //
        const clock_area = document.getElementById("clock_area");
        const design = { width: 800, height: 400 };
        const view = { width: design.width, height: design.height };

        const sizeCanvas = () => {
            const ratio = window.devicePixelRatio || 1;
            const css_width = clock_area.clientWidth;
            const scale = Math.max(0.25, Math.min(
                clock_area.clientHeight / design.height,
                css_width / design.width,
            ));
            view.width = css_width / scale;
            canvas.style.width = css_width + "px";
            canvas.style.height = view.height * scale + "px";
            canvas.width = Math.round(css_width * ratio);
            canvas.height = Math.round(view.height * scale * ratio);
            // resizing the canvas resets its transform, so scale it again
            context.setTransform(ratio * scale, 0, 0, ratio * scale, 0, 0);
        };

        sizeCanvas();

        //
        // make the label object
        //
        const label = raw_label(context, view);

        //
        // set event handlers and other variables
        //
        const dur_form = document.getElementById("dur_form");
        const dur_input = document.getElementById("dur_in_min");
        const reset_button = document.getElementById("resetbutton");
        const announcements = document.getElementById("announcements");
        dur_input.value = 180;

        let exam = null;
        let resetting = false;

        const startExam = (new_exam) => {
            exam = new_exam;
            bar.set_msg();
            // hiding the form gives its space to the clock
            dur_form.hidden = true;
            reset_button.hidden = false;
            keepScreenAwake();

            // start the animation loop
            tick();
        };

        //
        // To save battery, the clock is redrawn 30 times a second only while
        // a reminder message is sliding in or out. Otherwise nothing on screen
        // changes between seconds, so it's redrawn just after the current time
        // or the time remaining next changes.
        //
        let tick_timer = null;

        const tick = () => {
            animationLoop();
            const moving = scroll.state === "descending" || scroll.state === "ascending";
            let delay = 1000 / frame_rate;
            if (!moving) {
                const until_clock_changes = 1000 - (Date.now() % 1000);
                // the time remaining changes on the end time's second
                // boundaries, which needn't line up with the clock's
                const remaining = exam.remaining.millis();
                const until_remaining_changes = remaining > 0 ? (remaining % 1000 || 1000) : 1000;
                // the extra few milliseconds make sure the change has happened
                delay = Math.min(until_clock_changes, until_remaining_changes) + 5;
            }
            tick_timer = setTimeout(tick, delay);
        };

        // redraw immediately, e.g. after the canvas is resized (which clears it)
        const redrawNow = () => {
            clearTimeout(tick_timer);
            tick();
        };

        // the browser checks the duration against the input's min/max/step
        // and only submits the form (via button or Enter) when it's valid
        dur_form.addEventListener("submit", (event) => {
            event.preventDefault();
            const now = new Date();
            const end = new Date(now.getTime() + mins_to_millis(dur_input.valueAsNumber));
            const new_exam = makeExam(now, end);
            saveExam(new_exam);
            startExam(new_exam);
        });

        reset_button.onclick = () => {
            if (!confirm("Reset the timer and clear the announcement?")) return;
            storage.remove(exam_key);
            storage.remove(announcement_key);
            resetting = true;
            location.reload();
        };

        // ask before closing or reloading the tab while the exam is running
        window.addEventListener("beforeunload", (event) => {
            if (exam !== null && exam.going() && !resetting) {
                event.preventDefault();
                event.returnValue = "";
            }
        });

        // grow (or shrink) the announcement box to fit its text, but never
        // below the size given by its rows attribute
        const fitAnnouncements = () => {
            announcements.style.height = "auto";
            const border = announcements.offsetHeight - announcements.clientHeight;
            if (announcements.scrollHeight > announcements.clientHeight) {
                announcements.style.height = announcements.scrollHeight + border + "px";
            }
        };

        announcements.value = storage.get(announcement_key) ?? "";
        fitAnnouncements();
        announcements.addEventListener("input", () => {
            storage.set(announcement_key, announcements.value);
            fitAnnouncements();
        });

        //
        // the reminder messages can be edited (and are saved) at any time
        //
        const reminders_input = document.getElementById("reminders");
        reminders_input.value = storage.get(reminders_key) ?? default_reminders.join("\n");
        let reminders = parseReminders(reminders_input.value);

        reminders_input.addEventListener("input", () => {
            storage.set(reminders_key, reminders_input.value);
            reminders = parseReminders(reminders_input.value);
        });

        document.getElementById("defaultremindersbutton").onclick = () => {
            const defaults = default_reminders.join("\n");
            if (reminders_input.value === defaults) return;
            if (!confirm("Replace your reminder messages with the default ones?")) return;
            reminders_input.value = defaults;
            reminders_input.dispatchEvent(new Event("input"));
        };

        // a narrower window wraps the announcement onto more lines
        window.addEventListener("resize", fitAnnouncements);

        // Called whenever the clock's area changes size: the window is
        // resized, the announcement grows or shrinks, the duration form is
        // hidden, or full screen is turned on or off.
        const clockAreaResized = () => {
            sizeCanvas();
            bar.resize();
            // the canvas is cleared on resize, so repaint it right away
            if (exam === null) {
                background(yellow);
            } else {
                redrawNow();
            }
        };
        new ResizeObserver(clockAreaResized).observe(clock_area);

        // a change in pixel density (e.g. browser zoom, or moving the window
        // to another monitor) doesn't always resize the clock's area, so watch
        // for it directly; the query is for the current density, so it's
        // re-created after each change
        const watchPixelRatio = () => {
            matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener("change", () => {
                clockAreaResized();
                watchPixelRatio();
            }, { once: true });
        };
        watchPixelRatio();

        //
        // full screen hides the browser's toolbars, leaving more room for the clock
        //
        const fullscreen_button = document.getElementById("fullscreenbutton");
        if (document.fullscreenEnabled) {
            fullscreen_button.hidden = false;
            fullscreen_button.onclick = () => {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    document.documentElement.requestFullscreen()
                        .catch((err) => log(`full screen failed: ${err.message}`));
                }
            };
            document.addEventListener("fullscreenchange", () => {
                fullscreen_button.textContent = document.fullscreenElement ? "Exit full screen" : "Full screen";
            });
        }

        //
        // helper functions
        //
        const background = (color) => {
            context.fillStyle = color;
            context.fillRect(0, 0, view.width, view.height);
        };

        background(yellow);

        //
        // large message text info
        //
        const big_msg = {
            msg: "",
            y: 175,
            font: "90px serif",
            color: "blue",
        };

        //
        // progress bar info
        //
        const bar = {
            x: 30,
            y: 300,
            width: view.width - 60,
            height: 50,
            resize() {
                this.width = view.width - 60;
                this.height = 50;
                if (exam !== null) this.set_msg();
            },
            strokeStyle: "black",
            lineWidth: 1,
            color: "red",
            set_msg() {
                this.start_msg = label.make({ msg: `Start at ${formatTime(exam.time.start)}`, x: this.x, y: this.y - 10 });
                this.end_msg = label.make({ msg: `End at ${formatTime(exam.time.end)}`, x: -1, y: this.y - 10 });
                this.end_msg.x = this.width - this.end_msg.getWidthInPixels() + 25;
            },
            start_msg: null,
            end_msg: null,
        };

        //
        // text scroll
        //
        const scroll = {
            x: 0,
            y: 0,
            dx: 0,
            dy: 0,
            last_change: Date.now(),
            sit_time: 30 * 1000,  // milliseconds
            hide_time: 5 * 1000,
            state: "hiding",  // one of: finished, descending, ascending, sitting, hiding
            font_size: 25,
            draw() {
                if (this.state === "hiding") return;
                // shrink messages too long to fit across the clock
                context.font = `${this.font_size}px serif`;
                const width = context.measureText(this.msg).width;
                const size = Math.min(this.font_size, this.font_size * (view.width - 20) / width);
                label.center(this.msg, this.y, `${size}px serif`);
            },
            update() {
                const now = Date.now();
                const t = now - this.last_change;
                switch (this.state) {
                    case "finished":
                        this.dx = 0;
                        this.dy = 0;
                        this.y = 50;
                        this.msg = "Hand in your exam!";
                        break;
                    case "sitting":
                        this.dx = 0;
                        this.dy = 0;
                        if (t > this.sit_time) {
                            this.state = "ascending";
                            this.last_change = now;
                        }
                        break;
                    case "hiding":
                        this.dx = 0;
                        this.dy = 0;
                        // with no reminders, keep hiding until some are added
                        if (t > this.hide_time && reminders.length > 0) {
                            this.state = "descending";
                            this.last_change = now;
                            this.msg = randChoice(reminders);
                        }
                        break;
                    case "descending":
                        this.dx = 0;
                        this.dy = 1;
                        if (this.y >= 50) {
                            this.y = 50;
                            this.state = "sitting";
                            this.last_change = now;
                        }
                        break;
                    case "ascending":
                        this.dx = 0;
                        this.dy = -1;
                        if (this.y <= 0) {
                            this.y = 0;
                            this.state = "hiding";
                            this.last_change = now;
                        }
                        break;
                }
                this.x += this.dx;
                this.y += this.dy;
            },
            msg: "<msg>",
        };

        const animationLoop = () => {
            background(yellow);

            //
            // set colors and messages based on time remaining
            //
            if (exam.finished()) {
                bar.color = "green";
                big_msg.msg = "Exam is finished!";
                big_msg.color = "green";
                scroll.state = "finished";
            } else if (exam.remaining.minutes() <= 1) {
                bar.color = dark_red;
                const seconds = exam.remaining.seconds();
                big_msg.msg = seconds + (seconds === 1 ? " second left" : " seconds left");
                big_msg.color = dark_red;
            } else if (exam.remaining.minutes() <= 10) {
                bar.color = dark_orange;
                big_msg.msg = exam.remaining.minutes() + " minutes left";
                big_msg.color = dark_orange;
            } else {
                bar.color = "blue";
                big_msg.msg = exam.remaining.minutes() + " minutes left";
                big_msg.color = "blue";
            }

            //
            // draw the time remaining, current time, and start/end time labels
            //
            label.center(big_msg.msg, big_msg.y, big_msg.font, big_msg.color);
            label.center(currentTimeString(true), 210, "30px serif");
            bar.start_msg.render();
            bar.end_msg.render();

            //
            // progress bar
            //
            context.strokeStyle = bar.strokeStyle;
            context.lineWidth = bar.lineWidth;
            context.strokeRect(bar.x, bar.y, bar.width, bar.height);

            context.fillStyle = bar.color;

            // w is the width of the progress bar
            const millis_left = exam.remaining.millis();
            const w = constrained_map(millis_left, exam.duration.millis, 0, 0, bar.width);
            context.fillRect(bar.x, bar.y, w, bar.height);

            // calculate and display the % completed
            const pct = constrained_map(millis_left, exam.duration.millis, 0, 0, 100);
            const pct_msg = Math.floor(pct) + "% done";
            const pct_msg_width = context.measureText(pct_msg).width;
            label.put(pct_msg, constrain(w, bar.x, view.width - (pct_msg_width + 3)), bar.y + 75);

            //
            // scroll bar
            //
            scroll.draw();
            scroll.update();
        };

        //
        // resume an exam that was running before the page was reloaded
        //
        const saved_exam = loadSavedExam();
        if (saved_exam !== null) startExam(saved_exam);
    };

    //
    // The "load" event occurs when the HTML page finishes loading.
    //
    window.addEventListener("load", canvasApp);
})();
