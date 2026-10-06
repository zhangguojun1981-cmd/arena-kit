package com.termux.view;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Typeface;
import android.text.InputType;
import android.view.*;
import android.view.inputmethod.*;
import com.termux.terminal.TerminalEmulator;
import java.nio.charset.StandardCharsets;

/** SSH adapter around the upstream VT emulator/renderer. Never spawns a local process. */
public class TerminalCanvas extends View {
    public interface Client { void write(byte[] bytes); void resized(int columns, int rows); }
    private TerminalEmulator emulator;
    private TerminalRenderer renderer;
    private Client client;
    private int top = 0;
    private float lastY;
    private boolean moved;
    private boolean ctrl;
    private float fontSp = 13;
    public TerminalCanvas(Context context) {
        super(context); setFocusable(true); setFocusableInTouchMode(true);
        setContentDescription("SSH 交互终端；点击输入，上下滑动查看历史。使用工具栏复制可见文本。");
        rebuildRenderer();
    }
    private void rebuildRenderer() { renderer = new TerminalRenderer(Math.round(fontSp * getResources().getDisplayMetrics().scaledDensity), Typeface.MONOSPACE); resize(); invalidate(); }
    public void setFontSp(float value) { value = Math.max(11f, Math.min(14f, value)); if(fontSp != value) { fontSp = value; rebuildRenderer(); } }
    public void setCtrl(boolean value) { ctrl = value; }
    public void attach(TerminalEmulator value, Client valueClient) { if(emulator != value) top=0; emulator=value; client=valueClient; resize(); invalidate(); }
    public void detach() { client=null; emulator=null; }
    public void changed() { if(emulator != null) top=Math.max(-emulator.getScreen().getActiveTranscriptRows(),top); invalidate(); }
    public void bottom() { top=0; invalidate(); }
    public String visibleText() { return emulator == null ? "" : emulator.getScreen().getSelectedText(0,top,emulator.mColumns,top+emulator.mRows-1); }
    private void resize() {
        if(emulator == null || getWidth()==0 || getHeight()==0) return;
        int columns=Math.max(10,(int)(getWidth()/renderer.mFontWidth));
        int rows=Math.max(3,(getHeight()-renderer.mFontLineSpacingAndAscent)/renderer.mFontLineSpacing);
        if(columns!=emulator.mColumns || rows!=emulator.mRows) { emulator.resize(columns,rows); if(client!=null)client.resized(columns,rows); }
    }
    @Override protected void onSizeChanged(int w,int h,int oldw,int oldh) { resize(); }
    @Override protected void onDraw(Canvas canvas) {
        canvas.drawColor(0xff0b1019);
        if(emulator!=null) renderer.render(emulator,canvas,top,-1,-1,-1,-1);
    }
    private void send(String text) {
        if(client==null)return;
        if(ctrl && text.length()==1) { char c=text.charAt(0); if(c>='@' && c<='_')text=String.valueOf((char)(c-64)); else if(c>='a' && c<='z')text=String.valueOf((char)(c-96)); }
        client.write(text.getBytes(StandardCharsets.UTF_8)); bottom();
    }
    @Override public boolean onCheckIsTextEditor() { return true; }
    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        info.inputType=InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD|InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS;
        info.imeOptions=EditorInfo.IME_FLAG_NO_EXTRACT_UI|EditorInfo.IME_FLAG_NO_FULLSCREEN|EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING|EditorInfo.IME_ACTION_SEND;
        return new BaseInputConnection(this,false) {
            private String composing = "";
            @Override public boolean commitText(CharSequence text,int pos) { composing="";send(text.toString());return true; }
            @Override public boolean setComposingText(CharSequence text,int pos) { composing=text.toString();return true; }
            @Override public boolean finishComposingText() { if(!composing.isEmpty()) { send(composing);composing=""; } return true; }
            @Override public boolean deleteSurroundingText(int before,int after) { if(!composing.isEmpty()) { composing=composing.substring(0,Math.max(0,composing.length()-before));return true; } for(int i=0;i<Math.min(before,100);i++)send("\u007f"); return true; }
            @Override public boolean sendKeyEvent(KeyEvent event) { return event.getAction()!=KeyEvent.ACTION_DOWN || onKeyDown(event.getKeyCode(),event); }
            @Override public boolean performEditorAction(int code) { send("\r");return true; }
        };
    }
    @Override public boolean onKeyDown(int code,KeyEvent event) {
        String seq;
        switch(code) {
            case KeyEvent.KEYCODE_ENTER: seq="\r";break;
            case KeyEvent.KEYCODE_DEL: seq="\u007f";break;
            case KeyEvent.KEYCODE_FORWARD_DEL: seq="\u001b[3~";break;
            case KeyEvent.KEYCODE_TAB: seq="\t";break;
            case KeyEvent.KEYCODE_ESCAPE: seq="\u001b";break;
            case KeyEvent.KEYCODE_DPAD_UP: seq="\u001b"+(emulator!=null && emulator.isCursorKeysApplicationMode()?"O":"[")+"A";break;
            case KeyEvent.KEYCODE_DPAD_DOWN: seq="\u001b"+(emulator!=null && emulator.isCursorKeysApplicationMode()?"O":"[")+"B";break;
            case KeyEvent.KEYCODE_DPAD_LEFT: seq="\u001b"+(emulator!=null && emulator.isCursorKeysApplicationMode()?"O":"[")+"D";break;
            case KeyEvent.KEYCODE_DPAD_RIGHT: seq="\u001b"+(emulator!=null && emulator.isCursorKeysApplicationMode()?"O":"[")+"C";break;
            default:
                int c=event.getUnicodeChar(); if(c==0)return super.onKeyDown(code,event);
                if(event.isCtrlPressed() && c>='a' && c<='z')c-=96;
                seq=(event.isAltPressed()?"\u001b":"")+new String(Character.toChars(c));
        }
        send(seq); return true;
    }
    @Override public boolean onTouchEvent(android.view.MotionEvent event) {
        if(event.getAction()==MotionEvent.ACTION_DOWN) { lastY=event.getY();moved=false;return true; }
        if(event.getAction()==MotionEvent.ACTION_MOVE && emulator!=null) {
            int rows=(int)((lastY-event.getY())/renderer.mFontLineSpacing);
            if(rows!=0) { moved=true; top=Math.min(0,Math.max(-emulator.getScreen().getActiveTranscriptRows(),top+rows));lastY=event.getY();invalidate(); }
            return true;
        }
        if(event.getAction()==MotionEvent.ACTION_UP) { if(!moved)performClick();return true; }
        return true;
    }
    public void showKeyboard() {
        requestFocus();
        post(() -> {
            InputMethodManager manager=(InputMethodManager)getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            manager.restartInput(this);
            manager.showSoftInput(this,InputMethodManager.SHOW_IMPLICIT);
        });
    }
    @Override public boolean performClick() { super.performClick();showKeyboard();return true; }
}
