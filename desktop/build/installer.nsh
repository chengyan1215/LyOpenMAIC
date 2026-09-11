!macro customUnInstallSection
  Section /o "同时删除应用数据（课程、设置和缓存）" SEC_DELETE_APP_DATA
    # Electron stores user data per Windows account, even when the application
    # itself was installed for every user. Match electron-builder's own cleanup
    # paths so this option removes only data belonging to 智学课堂.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  SectionEnd
!macroend
