$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$build = Join-Path $root '.build\tests'
New-Item -ItemType Directory -Force -Path $build | Out-Null
$where = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compiler = & $where -latest -products '*' -find 'VC\Tools\MSVC\**\bin\Hostx64\x64\cl.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSVC C compiler not found' }
$vc = [IO.Path]::GetFullPath((Join-Path (Split-Path $compiler) '..\..\..'))
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$version = (Get-ChildItem (Join-Path $sdk 'Include') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).Name
$env:PATH = (Split-Path $compiler) + ';' + $env:PATH
Push-Location $build
try {
  & $compiler /nologo /W4 /WX /std:c11 /Od /D_CRT_SECURE_NO_WARNINGS "/I$root\Core\Inc" "/I$vc\include" "/I$sdk\Include\$version\ucrt" "$root\tests\firmware_test.c" "$root\Core\Src\pv_app.c" "$root\Core\Src\pv_sensor_codec.c" "$root\Core\Src\pv_store_codec.c" /Fefirmware_test.exe /link "/LIBPATH:$vc\lib\x64" "/LIBPATH:$sdk\Lib\$version\ucrt\x64" "/LIBPATH:$sdk\Lib\$version\um\x64"
  if ($LASTEXITCODE) { throw 'Firmware host test compilation failed' }
  & '.\firmware_test.exe'
  if ($LASTEXITCODE) { throw 'Firmware regression test failed' }
  & $compiler /nologo /W4 /WX /std:c11 /Od /D_CRT_SECURE_NO_WARNINGS "/I$root\tests\mocks" "/I$root\Core\Inc" "/I$vc\include" "/I$sdk\Include\$version\ucrt" "$root\tests\serial_io_test.c" "$root\Core\Src\pv_io.c" /Feserial_io_test.exe /link "/LIBPATH:$vc\lib\x64" "/LIBPATH:$sdk\Lib\$version\ucrt\x64" "/LIBPATH:$sdk\Lib\$version\um\x64"
  if ($LASTEXITCODE) { throw 'Serial IO host test compilation failed' }
  & '.\serial_io_test.exe'
  if ($LASTEXITCODE) { throw 'Serial IO regression test failed' }
  & $compiler /nologo /W4 /WX /std:c11 /Od /D_CRT_SECURE_NO_WARNINGS "/I$root\tests\mocks" "/I$root\Core\Inc" "/I$vc\include" "/I$sdk\Include\$version\ucrt" "$root\tests\sensor_io_test.c" "$root\Core\Src\pv_sensors.c" "$root\Core\Src\pv_sensor_codec.c" /Fesensor_io_test.exe /link "/LIBPATH:$vc\lib\x64" "/LIBPATH:$sdk\Lib\$version\ucrt\x64" "/LIBPATH:$sdk\Lib\$version\um\x64"
  if ($LASTEXITCODE) { throw 'Sensor IO host test compilation failed' }
  & '.\sensor_io_test.exe'
  if ($LASTEXITCODE) { throw 'Sensor IO regression test failed' }
} finally { Pop-Location }
