package com.smartchef.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

// Pure string logic — no Android runtime needed, unlike the resolvePath/
// list/readFile/writeFile/deleteFile coverage in SafMirrorPluginTest
// (androidTest), which needs a real DocumentFile/ContentResolver.
public class SafMirrorPluginPathTest {

    @Test
    public void parentPath_nested() {
        assertEquals(".git/objects/ab", SafMirrorPlugin.parentPath(".git/objects/ab/cd1234"));
    }

    @Test
    public void parentPath_topLevel() {
        assertEquals("", SafMirrorPlugin.parentPath("HEAD"));
    }

    @Test
    public void fileName_nested() {
        assertEquals("cd1234", SafMirrorPlugin.fileName(".git/objects/ab/cd1234"));
    }

    @Test
    public void fileName_topLevel() {
        assertEquals("HEAD", SafMirrorPlugin.fileName("HEAD"));
    }
}
